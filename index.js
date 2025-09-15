// index.js (verify-payment function)
const crypto = require('crypto');
const sdk = require('node-appwrite');

module.exports = async function (req, res) {
    try {
        const payload = req.payload ? JSON.parse(req.payload) : {};
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            localOrderId
        } = payload;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.json({ success: false, message: 'missing params' }, 400);
        }

        // compute expected signature
        const generated_signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + '|' + razorpay_payment_id)
            .digest('hex');

        const isValid = generated_signature === razorpay_signature;

        // init Appwrite client to update the order doc
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || process.env.APPWRITE_ENDPOINT)
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID)
            .setKey(process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY);
        const databases = new sdk.Databases(client);

        if (isValid) {
            // update order document to paid
            if (localOrderId) {
                await databases.updateDocument(
                    process.env.APPWRITE_DATABASE_ID,
                    process.env.APPWRITE_ORDERS_COLLECTION_ID,
                    localOrderId,
                    {
                        razorpay_payment_id,
                        razorpay_signature,
                        status: 'paid',
                        paidAt: new Date().toISOString()
                    }
                );
            }
            return res.json({ success: true, message: 'Payment verified' });
        } else {
            if (localOrderId) {
                await databases.updateDocument(
                    process.env.APPWRITE_DATABASE_ID,
                    process.env.APPWRITE_ORDERS_COLLECTION_ID,
                    localOrderId,
                    {
                        razorpay_payment_id,
                        razorpay_signature,
                        status: 'failed',
                        updatedAt: new Date().toISOString()
                    }
                );
            }
            return res.json({ success: false, message: 'Invalid signature' }, 400);
        }
    } catch (err) {
        console.error('verify-payment error', err);
        return res.json({ success: false, message: err.message || err.toString() }, 500);
    }
};
