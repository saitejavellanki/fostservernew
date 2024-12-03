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
    
    // Log incoming request details for debugging
    console.log('Transaction ID:', transactionId);
    console.log('Request Query:', req.query);
    console.log('Request Body:', req.body);


    // Validate required parameters
    if (!transactionId) {
      return res.status(400).send('Missing transaction ID');
    }

   

    if (true) {
      // Get the transaction from Firestore
      const transactionRef = admin.firestore().collection('transactions').where('txnid', '==', transactionId);
      const transactionSnapshot = await transactionRef.get();

      if (transactionSnapshot.empty) {
        return res.status(404).send('Transaction not found');
      }

      // There should only be one transaction with this ID
      const transactionDoc = transactionSnapshot.docs[0];
      const transactionData = transactionDoc.data();

      // Create the final order
      const orderData = {
        ...transactionData,
        status: 'pending',
        paymentStatus: 'completed',
        paymentDetails: req.body,
        confirmedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      // Save the order
      await admin.firestore().collection('orders').add(orderData);

      // Update the transaction status
      await transactionDoc.ref.update({
        status: 'completed',
        paymentStatus: 'success'
      });

      // Redirect to success page
      res.redirect('https://www.thefost.com/');
    } else {
      // Payment verification failed
      const transactionRef = admin.firestore().collection('transactions').where('txnid', '==', transactionId);
      const transactionSnapshot = await transactionRef.get();

      if (!transactionSnapshot.empty) {
        await transactionSnapshot.docs[0].ref.update({
          status: 'failed',
          paymentStatus: 'failed'
        });
      }

      res.redirect('https://www.thefost.com/payment-failed');
    }
  } catch (error) {
    console.error('Error processing payment success:', error);
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