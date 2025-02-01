const express = require('express');
const app = express();
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
require('dotenv').config();
const CryptoJS = require('crypto-js');

// Initialize Firebase Admin
const serviceAccountConfig = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountConfig)
});

const cors = require('cors');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Constants for webhook retry handling
const WEBHOOK_MAX_RETRIES = 3;
const WEBHOOK_RETRY_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds

// PayU webhook verification middleware
const verifyPayUWebhook = (req, res, next) => {
  try {
    console.log('Verifying PayU webhook signature');
    const { hash, key, txnid, status, amount } = req.body;
    const PAYU_SALT_KEY = process.env.PAYU_SALT_KEY;
    
    const hashString = `${PAYU_SALT_KEY}|${status}||||||||||${amount}|${txnid}|${key}`;
    const calculatedHash = CryptoJS.SHA512(hashString).toString();
    
    if (hash === calculatedHash) {
      console.log('PayU webhook signature verified successfully');
      next();
    } else {
      console.error('Invalid PayU webhook signature');
      res.status(401).json({ error: 'Invalid webhook signature' });
    }
  } catch (error) {
    console.error('Error verifying PayU webhook:', error);
    res.status(400).json({ error: 'Invalid webhook data' });
  }
};

// Helper function to process order creation
const createOrder = async (transactionData, paymentDetails = null, processType = 'webhook') => {
  const firestore = admin.firestore();
  const orderRef = firestore.collection('orders').doc();
  
  const orderData = {
    ...transactionData,
    status: 'pending',
    paymentStatus: 'completed',
    confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    processType: processType,
    ...(paymentDetails && { paymentDetails })
  };

  await orderRef.set(orderData);
  await sendOrderConfirmationEmail(orderRef.id, orderData);
  
  return orderRef.id;
};

// Initiate Payment Route
app.post('/initiate-payment', async (req, res) => {
  try {
    const { shopData, userData } = req.body;
    console.log('Starting payment initiation');

    // Validate required data
    if (!shopData || !userData || !shopData.total || !userData.email) {
      return res.status(400).json({ 
        error: 'Missing required payment data',
        message: 'Shop data and user data are required' 
      });
    }

    const txnid = `TXN_${Date.now()}`;
    const PAYU_MERCHANT_KEY = process.env.PAYU_MERCHANT_KEY;
    const PAYU_SALT_KEY = process.env.PAYU_SALT_KEY;
    
    // Create transaction data
    const transactionData = {
      shopId: shopData.shopId,
      ...(shopData.vendorId && { vendorId: shopData.vendorId }),
      userId: userData.uid,
      shopName: shopData.shopName,
      items: shopData.items?.map(item => ({
        id: item.id,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        category: item.category,
        dietType: item.dietType,
        imageUrl: item.imageUrl
      })) || [],
      total: parseFloat(shopData.total),
      status: 'pending',
      paymentStatus: 'pending',
      customerEmail: userData.email,
      firstname: userData.displayName || 'Customer',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      txnid: txnid
    };

    // Save transaction to Firestore
    await admin.firestore()
      .collection('transactions')
      .add(transactionData);

    // Prepare PayU payment parameters
    const paymentParams = {
      key: PAYU_MERCHANT_KEY,
      txnid: txnid,
      amount: shopData.total.toFixed(2),
      productinfo: `Order from ${shopData.shopName}`,
      firstname: userData.displayName || 'Customer',
      email: userData.email,
      phone: userData.phoneNumber || '',
      surl: `https://fostservernew-1.onrender.com/payment-success?transactionId=${txnid}`,
      furl: `${process.env.FRONTEND_URL}/payment-failure`,
    };

    // Generate hash
    const hashString = `${paymentParams.key}|${paymentParams.txnid}|${paymentParams.amount}|${paymentParams.productinfo}|${paymentParams.firstname}|${paymentParams.email}|||||||||||${PAYU_SALT_KEY}`;
    const hash = CryptoJS.SHA512(hashString).toString();
    
    res.json({
      ...paymentParams,
      hash: hash,
      payuBaseUrl: process.env.PAYU_BASE_URL || 'https://secure.payu.in/_payment'
    });

  } catch (error) {
    console.error('Payment initiation error:', error);
    res.status(500).json({ 
      error: 'Failed to initiate payment',
      message: error.message
    });
  }
});

// PayU Webhook Handler with retry logic
app.post('/payu-webhook', verifyPayUWebhook, async (req, res) => {
  try {
    console.log('Received PayU webhook:', JSON.stringify(req.body, null, 2));
    const { txnid, status, amount, mihpayid } = req.body;
    
    const firestore = admin.firestore();

    // Create a unique webhook ID using transaction ID and mihpayid
    const webhookId = `${txnid}_${mihpayid}`;

    // Check for existing webhook processing record
    const webhookRef = firestore.collection('webhook_attempts').doc(webhookId);
    const webhookDoc = await webhookRef.get();

    if (webhookDoc.exists) {
      const webhookData = webhookDoc.data();
      
      // If webhook was already successfully processed, return success
      if (webhookData.status === 'success') {
        console.log('Webhook already successfully processed:', webhookId);
        return res.status(200).json({ message: 'Webhook already processed' });
      }
      
      // If max retries reached, return error
      if (webhookData.attempts >= WEBHOOK_MAX_RETRIES) {
        console.error('Max retry attempts reached for webhook:', webhookId);
        return res.status(429).json({ error: 'Max retry attempts reached' });
      }
      
      // Update attempt count
      await webhookRef.update({
        attempts: admin.firestore.FieldValue.increment(1),
        lastAttempt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      // Create new webhook attempt record
      await webhookRef.set({
        txnid,
        mihpayid,
        status: 'pending',
        attempts: 1,
        firstAttempt: admin.firestore.FieldValue.serverTimestamp(),
        lastAttempt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Use transaction ID as deduplication key for orders
    const existingOrderSnapshot = await firestore
      .collection('orders')
      .where('txnid', '==', txnid)
      .get();

    if (!existingOrderSnapshot.empty) {
      console.log('Order already exists for transaction:', txnid);
      await webhookRef.update({
        status: 'success',
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(200).json({ message: 'Order already processed' });
    }

    // Process the webhook within a transaction for atomicity
    await firestore.runTransaction(async (transaction) => {
      // Lock the transaction record
      const transactionQuery = await transaction.get(
        firestore.collection('transactions').where('txnid', '==', txnid)
      );
      
      if (transactionQuery.empty) {
        throw new Error('Transaction not found');
      }

      const transactionDoc = transactionQuery.docs[0];
      const transactionData = transactionDoc.data();
      
      // Double-check order doesn't exist within transaction
      const orderQuery = await transaction.get(
        firestore.collection('orders').where('txnid', '==', txnid)
      );
      
      if (!orderQuery.empty) {
        throw new Error('Order already exists');
      }

      if (status.toLowerCase() === 'success') {
        // Create order
        const orderId = await createOrder(transactionData, req.body, 'webhook');

        // Update transaction
        transaction.update(transactionDoc.ref, {
          status: 'completed',
          paymentStatus: 'success',
          webhookProcessed: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          orderId: orderId,
          mihpayid: mihpayid
        });

        // Mark webhook as successfully processed
        transaction.update(webhookRef, {
          status: 'success',
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          orderId: orderId
        });
      } else {
        // Handle failed payment
        transaction.update(transactionDoc.ref, {
          status: 'failed',
          paymentStatus: 'failed',
          failureReason: req.body.error_Message || 'Payment failed',
          webhookProcessed: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          mihpayid: mihpayid
        });

        // Mark webhook as completed even for failed payments
        transaction.update(webhookRef, {
          status: 'success',
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          paymentStatus: 'failed'
        });
      }
    });

    res.status(200).json({ message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('Webhook processing error:', error);
    
    // If this is a duplicate order error, return success to prevent retries
    if (error.message === 'Order already exists') {
      return res.status(200).json({ message: 'Order already processed' });
    }
    
    // For other errors, return 500 to trigger PayU's retry mechanism
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Payment Success Route
app.post('/payment-success', async (req, res) => {
  try {
    const { transactionId } = req.query;
    console.log('Processing payment success for transaction:', transactionId);
    
    if (!transactionId) {
      console.error('Missing transaction ID in success callback');
      return res.redirect(`${process.env.FRONTEND_URL}/payment-failure`);
    }

    const firestore = admin.firestore();
    
    // Find the transaction
    const transactionSnapshot = await firestore
      .collection('transactions')
      .where('txnid', '==', transactionId)
      .get();

    if (transactionSnapshot.empty) {
      console.error('Transaction not found:', transactionId);
      return res.redirect(`${process.env.FRONTEND_URL}/payment-failure`);
    }

    const transactionDoc = transactionSnapshot.docs[0];
    const transactionData = transactionDoc.data();

    // Check if webhook has already processed this transaction
    if (transactionData.webhookProcessed) {
      console.log('Transaction already processed by webhook');
      const orderSnapshot = await firestore
        .collection('orders')
        .where('txnid', '==', transactionId)
        .get();
      
      if (!orderSnapshot.empty) {
        return res.redirect(`https://www.thefost.com/order-waiting/${orderSnapshot.docs[0].id}`);
      }
    }

    // If webhook hasn't processed it yet, handle it here
    const orderSnapshot = await firestore
      .collection('orders')
      .where('txnid', '==', transactionId)
      .get();

    let orderId;

    if (orderSnapshot.empty) {
      // Create new order
      orderId = await createOrder(transactionData, null, 'redirect');

      // Update transaction
      await transactionDoc.ref.update({
        status: 'completed',
        paymentStatus: 'success',
        manuallyProcessed: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      orderId = orderSnapshot.docs[0].id;
    }

    // Redirect to order waiting page
    res.redirect(`https://www.thefost.com/order-waiting/${orderId}`);
  } catch (error) {
    console.error('Error processing payment success:', error);
    res.redirect(`${process.env.FRONTEND_URL}/payment-failure`);
  }
});

// Helper function to send order confirmation email
const sendOrderConfirmationEmail = async (orderId, orderData) => {
  const formattedItems = orderData.items.map(item => 
    `${item.name} x ${item.quantity} - ₹${(item.price * item.quantity).toFixed(2)}`
  ).join('\n');

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: orderData.customerEmail,
    subject: `Order Confirmation - ${orderData.shopName} - Order #${orderId.slice(-6)}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #4A5568;">Order Confirmation</h1>
        </div>
        
        <div style="background-color: #F7FAFC; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <p style="margin: 0;">Hi ${orderData.firstname || 'Valued Customer'},</p>
          <p>Thank you for your order! We're pleased to confirm that your order has been received and is being processed.</p>
        </div>
        
        <div style="margin-bottom: 20px;">
          <h2 style="color: #4A5568; font-size: 18px;">Order Details:</h2>
          <p style="margin: 5px 0;">Order Number: #${orderId.slice(-6)}</p>
          <p style="margin: 5px 0;">Restaurant/Store: ${orderData.shopName}</p>
          <p style="margin: 5px 0;">Payment Method: Online Payment</p>
        </div>
        
        <div style="margin-bottom: 20px;">
          <h3 style="color: #4A5568; font-size: 16px;">Items Ordered:</h3>
          <ul style="list-style: none; padding: 0;">
            ${orderData.items.map(item => `
              <li style="padding: 10px; background-color: #F7FAFC; margin-bottom: 5px; border-radius: 4px;">
                ${item.name} x ${item.quantity} - ₹${(item.price * item.quantity).toFixed(2)}
              </li>
            `).join('')}
          </ul>
        </div>
        
        <div style="background-color: #F7FAFC; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
          <p style="margin: 0; font-size: 18px; font-weight: bold;">
            Total Amount: ₹${orderData.total.toFixed(2)}
          </p>
        </div>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Order confirmation email sent successfully');
  } catch (error) {
    console.error('Error sending order confirmation email:', error);
  }
};

const PORT = process.env.PORT || 5058;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;