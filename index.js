// create-order/index.js
require('dotenv').config();
const Razorpay = require('razorpay');
const { Client, Databases, ID } = require('node-appwrite');

(async function main() {
    try {
        // Parse payload
        let payload = {};
        if (process.env.APPWRITE_FUNCTION_DATA) {
            try {
                payload = JSON.parse(process.env.APPWRITE_FUNCTION_DATA);
            } catch (e) {
                console.log(JSON.stringify({ success: false, message: 'invalid function data', error: String(e) }));
                process.exit(1);
            }
        } else {
            console.log(JSON.stringify({ success: false, message: 'missing function payload' }));
            process.exit(1);
        }

        const { amount, currency = 'INR', receipt, userId, items } = payload;
        if (!amount || !userId) {
            console.log(JSON.stringify({ success: false, message: 'amount and userId required', payload }));
            process.exit(1);
        }

        // Env validation - check both function context and regular env vars
        const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
        const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
        const APPWRITE_ENDPOINT = process.env.APPWRITE_FUNCTION_ENDPOINT || process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT = process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY;
        const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        // Log env status for debugging (don't log actual keys)
        console.log(JSON.stringify({
            info: 'env check',
            hasRazorpayId: !!RAZORPAY_KEY_ID,
            hasRazorpaySecret: !!RAZORPAY_KEY_SECRET,
            hasAppwriteEndpoint: !!APPWRITE_ENDPOINT,
            hasAppwriteProject: !!APPWRITE_PROJECT,
            hasAppwriteApiKey: !!APPWRITE_API_KEY,
            hasDatabaseId: !!DATABASE_ID,
            hasOrdersCollectionId: !!ORDERS_COLLECTION_ID
        }));

        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
            console.log(JSON.stringify({ success: false, message: 'missing razorpay keys' }));
            process.exit(1);
        }
        if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT || !APPWRITE_API_KEY) {
            console.log(JSON.stringify({ success: false, message: 'missing appwrite server config' }));
            process.exit(1);
        }
        if (!DATABASE_ID || !ORDERS_COLLECTION_ID) {
            console.log(JSON.stringify({ success: false, message: 'missing database/collection ids' }));
            process.exit(1);
        }

        // Create Razorpay order
        const razor = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
        const amountPaise = Math.round(Number(amount) * 100);
        const orderOptions = {
            amount: amountPaise,
            currency,
            receipt: receipt || `rcpt_${Date.now()}`,
            payment_capture: 1,
            notes: { appwriteUserId: userId },
        };

        console.log(JSON.stringify({ info: 'creating razorpay order', amount: amountPaise, currency }));
        const razorOrder = await razor.orders.create(orderOptions);
        console.log(JSON.stringify({ info: 'razorpay order created', orderId: razorOrder.id }));

        // Init Appwrite SDK
        const client = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT)
            .setKey(APPWRITE_API_KEY);

        const databases = new Databases(client);

        // Prepare items array - ensure each item fits your schema constraints
        const itemsIds = Array.isArray(items)
            ? items.map(item => {
                if (typeof item === 'string') return item.slice(0, 499);
                if (item && item.productId) return String(item.productId).slice(0, 499);
                return String(item).slice(0, 499);
            }).filter(Boolean)
            : [];

        // Store complete items data as JSON for later reference
        const itemsJson = JSON.stringify(items || []);

        // Create order document - match your collection schema exactly
        const localOrder = {
            userId,
            items: itemsIds,          // Array of strings, each max 499 chars
            amount: Number(amount),   // Ensure it's a number
            currency,
            receipt: orderOptions.receipt,
            razorpay_order_id: razorOrder.id,
            status: 'created',
            items_json: itemsJson,    // Full JSON data
            // Don't include $createdAt - Appwrite manages this automatically
        };

        console.log(JSON.stringify({ info: 'creating appwrite order doc', itemsCount: itemsIds.length }));
        const orderDoc = await databases.createDocument(DATABASE_ID, ORDERS_COLLECTION_ID, ID.unique(), localOrder);
        console.log(JSON.stringify({ info: 'appwrite order created', docId: orderDoc.$id }));

        // Success response
        const result = {
            success: true,
            razorOrder,
            localOrderId: orderDoc.$id
        };
        console.log(JSON.stringify(result));
        process.exit(0);

    } catch (err) {
        // Enhanced error logging
        const errorInfo = {
            success: false,
            message: err.message || String(err),
            errorType: err.constructor.name,
            stack: err.stack
        };

        console.error('create-order error details:', errorInfo);
        console.log(JSON.stringify({ success: false, message: errorInfo.message }));
        process.exit(1);
    }
})();