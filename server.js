const express = require('express');
const app = express();
const admin = require('firebase-admin');
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

// Use dynamic port or fallback to 5002
const PORT = process.env.PORT || 5052;

// Middleware to parse URL-encoded bodies
app.use(express.urlencoded({ extended: true })); 
app.use(express.json()); // Add JSON parsing middleware

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