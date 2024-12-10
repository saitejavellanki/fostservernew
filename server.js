const express = require('express');
const app = express();
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
require('dotenv').config();

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
const PORT = process.env.PORT || 5052;

// Middleware to parse URL-encoded bodies
app.use(express.urlencoded({ extended: true })); 
app.use(express.json()); // Add JSON parsing middleware

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
        
        // If an order already exists, skip order creation
        if (!existingOrderSnapshot.empty) {
          console.log('Order already exists for this transaction');
          return;
        }
        
        // Get the transaction document
        const transactionDoc = transactionSnapshot.docs[0];
        const transactionData = transactionDoc.data();
        
        // Prepare order data
        const orderData = {
          ...transactionData,
          txnid: transactionId,
          status: 'pending',
          paymentStatus: 'completed',
          paymentDetails: req.body,
          confirmedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        // Create the order
        transaction.create(orderCollection.doc(), orderData);
        
        // Update transaction status
        transaction.update(transactionDoc.ref, {
          status: 'completed',
          paymentStatus: 'success'
        });
      });
      
      // Redirect to success page
      res.redirect('https://www.thefost.com/');
    } catch (error) {
      console.error('Error processing payment success:', error);
      
      // Check if it's a duplicate order error
      if (error.message === 'Order already exists for this transaction') {
        return res.redirect('https://www.thefost.com/');
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