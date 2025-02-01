const express = require('express');
const app = express();
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
require('dotenv').config();
const CryptoJS = require('crypto-js');

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
app.use(cors()); // Add this before your routes

// Configure Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail', // or another email service
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Use dynamic port or fallback to 5002
const PORT = process.env.PORT || 5058;

// Middleware to parse URL-encoded bodies
app.use(express.urlencoded({ extended: true })); 
app.use(express.json()); // Add JSON parsing middleware

app.post('/initiate-payment', async (req, res) => {
  try {
    const { shopData, userData } = req.body;
    console.log('starting payment');
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
    
    // Create transaction data with error handling
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      txnid: txnid,
      clearCart: true,
      orderType: shopData.shopId === 'grocery-store' ? 'grocery' : 'restaurant'
    };

    // Save transaction to Firestore with error handling
    const transactionRef = await admin.firestore()
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
      surl: `https://fostservernew.onrender.com/payment-success?transactionId=${txnid}`,
      furl: `${process.env.FRONTEND_URL}/payment-failure`,
    };

    // Generate hash with error handling
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
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});


app.post('/send-order-confirmation', async (req, res) => {
  try {
    const { 
      orderId, 
      customerEmail, 
      shopName, 
      customerName, 
      items,
      total,
      paymentMethod = 'Online Payment' // default value
    } = req.body;

    // Validate input
    if (!customerEmail || !orderId || !shopName || !items || !total) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Normalize items to an array if it's not already
    const itemsList = Array.isArray(items) 
      ? items 
      : typeof items === 'string' 
        ? [items] 
        : [];

    // Format total amount
    const formattedTotal = parseFloat(total).toFixed(2);

    // Prepare email content
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: customerEmail,
      subject: `Order Confirmation - ${shopName} - Order #${orderId.slice(-6)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #4A5568;">Order Confirmation</h1>
          </div>
          
          <div style="background-color: #F7FAFC; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <p style="margin: 0;">Hi ${customerName},</p>
            <p>Thank you for your order! We're pleased to confirm that your order has been received and is being processed.</p>
          </div>
          
          <div style="margin-bottom: 20px;">
            <h2 style="color: #4A5568; font-size: 18px;">Order Details:</h2>
            <p style="margin: 5px 0;">Order Number: #${orderId.slice(-6)}</p>
            <p style="margin: 5px 0;">Restaurant/Store: ${shopName}</p>
            <p style="margin: 5px 0;">Payment Method: ${paymentMethod}</p>
          </div>
          
          <div style="margin-bottom: 20px;">
            <h3 style="color: #4A5568; font-size: 16px;">Items Ordered:</h3>
            <ul style="list-style: none; padding: 0;">
              ${itemsList.map(item => `
                <li style="padding: 10px; background-color: #F7FAFC; margin-bottom: 5px; border-radius: 4px;">
                  ${item}
                </li>
              `).join('')}
            </ul>
          </div>
          
          <div style="background-color: #F7FAFC; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
            <p style="margin: 0; font-size: 18px; font-weight: bold;">
              Total Amount: ₹${formattedTotal}
            </p>
          </div>
          
          <div style="border-top: 2px solid #E2E8F0; padding-top: 20px; margin-top: 20px;">
            <p style="color: #4A5568; font-size: 14px;">
              We'll notify you when your order is ready for pickup. You can track your order status on our website.
            </p>
            <p style="color: #4A5568; font-size: 14px;">
              Thank you for choosing ${shopName}!
            </p>
          </div>
        </div>
      `
    };

    // Send email
    await transporter.sendMail(mailOptions);

    res.status(200).json({ message: 'Order confirmation email sent successfully' });
  } catch (error) {
    console.error('Failed to send order confirmation email:', error);
    res.status(500).json({ 
      message: 'Failed to send order confirmation email',
      error: error.message 
    });
  }
});


// New route for sending order ready notification
app.post('/sendnotification', async (req, res) => {
    try {
      const { 
        orderId, 
        customerEmail, 
        shopName, 
        customerName, 
        items 
      } = req.body;
  
      // Validate input
      if (!customerEmail || !orderId || !shopName) {
        return res.status(400).json({ message: 'Missing required fields' });
      }
  
      // Normalize items to an array
      const itemsList = Array.isArray(items) 
        ? items 
        : typeof items === 'string' 
          ? [items] 
          : [];
  
      // Prepare email content
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: customerEmail,
        subject: `Your Order is Ready for Pickup - ${shopName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Order Ready for Pickup</h2>
            <p>Hi ${customerName},</p>
            <p>Your order #${orderId.slice(-6)} is now ready for pickup at <strong>${shopName}</strong>.</p>
            
            <h3>Order Details:</h3>
            <ul>
              ${itemsList.map(item => `<li>${item}</li>`).join('')}
            </ul>
            
            <p>Please come to the shop to collect your order.</p>
            <p>Thank you for your business!</p>
          </div>
        `
      };
  
      // Send email
      await transporter.sendMail(mailOptions);
  
      res.status(200).json({ message: 'Notification sent successfully' });
    } catch (error) {
      console.error('Failed to send notification', error);
      res.status(500).json({ 
        message: 'Failed to send notification',
        error: error.message 
      });
    }
  });
// Existing payment-success route
app.post('/payment-success', async (req, res) => {
  try {
    const { transactionId } = req.query;
    
    // Validate required parameters
    if (!transactionId) {
      return res.status(400).send('Missing transaction ID');
    }
    
    // Use a transaction to ensure atomic operation
    const firestore = admin.firestore();
    const orderCollection = firestore.collection('orders');
    const transactionCollection = firestore.collection('transactions');
    let orderId;
    let orderData;

    // Perform a firestore transaction
    await firestore.runTransaction(async (transaction) => {
      // Find the transaction
      const transactionQuery = transactionCollection.where('txnid', '==', transactionId);
      const transactionSnapshot = await transaction.get(transactionQuery);
      
      if (transactionSnapshot.empty) {
        throw new Error('Transaction not found');
      }
      
      // Check if an order already exists for this transaction
      const existingOrderQuery = orderCollection.where('txnid', '==', transactionId);
      const existingOrderSnapshot = await transaction.get(existingOrderQuery);
      
      // If an order already exists, get its ID and skip order creation
      if (!existingOrderSnapshot.empty) {
        orderId = existingOrderSnapshot.docs[0].id;
        orderData = existingOrderSnapshot.docs[0].data();
        console.log('Order already exists for this transaction');
        return;
      }
      
      // Get the transaction document
      const transactionDoc = transactionSnapshot.docs[0];
      const transactionData = transactionDoc.data();
      
      // Prepare order data
      orderData = {
        ...transactionData,
        txnid: transactionId,
        status: 'pending',
        paymentStatus: 'completed',
        paymentDetails: req.body,
        confirmedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      
      // Create the order and store its ID
      const newOrderRef = orderCollection.doc();
      orderId = newOrderRef.id;
      transaction.create(newOrderRef, orderData);
      
      // Update transaction status
      transaction.update(transactionDoc.ref, {
        status: 'completed',
        paymentStatus: 'success'
      });
    });

    // Send order confirmation email
    try {
      // Format items for email
      const formattedItems = orderData.items.map(item => 
        `${item.name} x ${item.quantity} - ₹${(item.price * item.quantity).toFixed(2)}`
      );

      await axios.post(`https://fostservernew.onrender.com/send-order-confirmation`, {
        orderId: orderId,
        customerEmail: orderData.customerEmail,
        shopName: orderData.shopName,
        customerName: orderData.firstname || 'Valued Customer',
        items: formattedItems,
        total: orderData.total,
        paymentMethod: 'Online Payment'
      });

      console.log('Order confirmation email sent successfully');
    } catch (emailError) {
      console.error('Failed to send order confirmation email:', emailError);
      // Don't throw error here - we still want to redirect the user even if email fails
    }
    
    // Redirect to order waiting page with the order ID
    res.redirect(`https://www.thefost.com/order-waiting/${orderId}`);
  } catch (error) {
    console.error('Error processing payment success:', error);
    
    // Check if it's a duplicate order error and we have the order ID
    if (error.message === 'Order already exists for this transaction' && orderId) {
      return res.redirect(`https://www.thefost.com/order-waiting/${orderId}`);
    }
    
    res.status(500).send('Internal Server Error');
  }
});

// Add error handling for undefined routes
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// Improved server startup logging
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;