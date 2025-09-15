// verify-payment/index.js
// Node 16+ Appwrite Function
require('dotenv').config();
const crypto = require('crypto');
const { Client, Databases } = require('node-appwrite');

(async function main() {
    try {
        // 0) Read payload (Appwrite passes JSON string in APPWRITE_FUNCTION_DATA)
        let payload = {};
        if (process.env.APPWRITE_FUNCTION_DATA) {
            try {
                payload = JSON.parse(process.env.APPWRITE_FUNCTION_DATA);
            } catch (e) {
                console.error('Invalid APPWRITE_FUNCTION_DATA:', e);
                console.log(JSON.stringify({ success: false, message: 'invalid function data' }));
                process.exit(1);
            }
        } else {
            console.log(JSON.stringify({ success: false, message: 'missing function payload' }));
            process.exit(1);
        }

        // 1) Extract fields we expect from payload
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            localOrderId
        } = payload;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !localOrderId) {
            console.error('Missing verification fields', { payload });
            console.log(JSON.stringify({ success: false, message: 'missing verification fields' }));
            process.exit(1);
        }

        // 2) Env / config (set these in Function settings)
        const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
        const APPWRITE_ENDPOINT = process.env.APPWRITE_FUNCTION_ENDPOINT || process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT = process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY;
        const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        if (!RAZORPAY_KEY_SECRET) throw new Error('Missing RAZORPAY_KEY_SECRET in function env');
        if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT || !APPWRITE_API_KEY) throw new Error('Missing Appwrite server config');
        if (!DATABASE_ID || !ORDERS_COLLECTION_ID) throw new Error('Missing database/collection IDs');

        // 3) Verify signature: expected = HMAC_SHA256(order_id + "|" + payment_id, secret)
        const signatureData = `${razorpay_order_id}|${razorpay_payment_id}`;
        const expectedSignature = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(signatureData).digest('hex');
        const verified = expectedSignature === razorpay_signature;

        // 4) Initialize Appwrite server SDK (use server key)
        const client = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT)
            .setKey(APPWRITE_API_KEY);

        const databases = new Databases(client);

        // 5) Build safe update object
        // Only include attributes your Appwrite collection accepts. If your collection doesn't
        // have some fields, either add them in Console or remove them here.
        const updateDoc = {
            status: verified ? 'paid' : 'payment_failed',
            razorpay_payment_id,
            razorpay_signature,
            verification_raw: JSON.stringify({
                signatureData,
                expectedSignature,
                providedSignature: razorpay_signature,
                verified,
                timestamp: new Date().toISOString()
            })
        };

        // 6) Update the order document in Appwrite
        try {
            const updated = await databases.updateDocument(
                DATABASE_ID,
                ORDERS_COLLECTION_ID,
                localOrderId,
                updateDoc
            );
            console.log('Order updated:', updated.$id);
        } catch (err) {
            console.error('Failed to update Appwrite order:', err);
            console.log(JSON.stringify({ success: false, message: 'failed to update order', error: String(err) }));
            process.exit(1);
        }

        // 7) Return result
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
