// Minimal test function
const { Client, Databases, ID } = require('node-appwrite');

(async function test() {
    try {
        const client = new Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT)
            .setProject(process.env.APPWRITE_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const databases = new Databases(client);

        // Try to create a minimal document
        const testDoc = await databases.createDocument(
            process.env.APPWRITE_DATABASE_ID,
            process.env.APPWRITE_ORDERS_COLLECTION_ID,
            ID.unique(),
            {
                userId: 'test_user',
                amount: 100,
                currency: 'INR',
                status: 'test'
            }
        );

        console.log(JSON.stringify({ success: true, testDoc }));
        process.exit(0);
    } catch (err) {
        console.log(JSON.stringify({ success: false, error: err.message }));
        process.exit(1);
    }
})();