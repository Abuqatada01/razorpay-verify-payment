// verify-payment/index.js
require('dotenv').config();
const crypto = require('crypto');
const { Client, Databases } = require('node-appwrite');

(async function main() {
    try {
        let payload = {};
        if (process.env.APPWRITE_FUNCTION_DATA) payload = JSON.parse(process.env.APPWRITE_FUNCTION_DATA);
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, localOrderId } = payload;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !localOrderId) {
            console.log(JSON.stringify({ success: false, message: 'missing verification fields', payload }));
            process.exit(1);
        }

        const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
        const APPWRITE_ENDPOINT = process.env.APPWRITE_FUNCTION_ENDPOINT || process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT = process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY;
        const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        const signatureData = `${razorpay_order_id}|${razorpay_payment_id}`;
        const expectedSignature = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(signatureData).digest('hex');
        const verified = expectedSignature === razorpay_signature;

        const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT).setKey(APPWRITE_API_KEY);
        const databases = new Databases(client);

        const updateDoc = {
            status: verified ? 'paid' : 'payment_failed',
            razorpay_payment_id,
            razorpay_signature,
            updatedAt: new Date().toISOString(),
        };

        // if your collection doesn't accept these fields, adapt the keys
        const updated = await databases.updateDocument(DATABASE_ID, ORDERS_COLLECTION_ID, localOrderId, updateDoc);
        console.log('Order updated:', updated.$id);

        if (verified) {
            console.log(JSON.stringify({ success: true, message: 'payment verified', localOrderId }));
            process.exit(0);
        } else {
            console.log(JSON.stringify({ success: false, message: 'signature mismatch', localOrderId }));
            process.exit(1);
        }
    } catch (err) {
        console.error('verify-payment error:', err && (err.stack || err.message || err));
        console.log(JSON.stringify({ success: false, message: String(err && err.message ? err.message : err) }));
        process.exit(1);
    }
})();
