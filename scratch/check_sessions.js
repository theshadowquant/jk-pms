const { initializeApp } = require("firebase/app");
const { getFirestore, collection, query, where, getDocs, limit } = require("firebase/firestore");

const firebaseConfig = {
  apiKey: "AIzaSyCh-tCXGbS3oAHLlBlufQYeElZ2TGgfMlE",
  authDomain: "jk-pms.firebaseapp.com",
  projectId: "jk-pms",
  storageBucket: "jk-pms.firebasestorage.app",
  messagingSenderId: "402199134787",
  appId: "1:402199134787:web:b42d8954a1cd4bb33a8af6",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  console.log("Checking sales_import_sessions collection...");
  const sessionsSnap = await getDocs(collection(db, "sales_import_sessions"));
  console.log(`Found ${sessionsSnap.size} sessions:`);
  sessionsSnap.forEach(doc => {
    const data = doc.data();
    console.log(`- Session ID: ${doc.id}, Status: ${data.status}, Date: ${data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt}, Bills count: ${data.totalBills}`);
  });

  console.log("\nChecking sales collection for isImported === true...");
  const importedSalesQuery = query(collection(db, "sales"), where("isImported", "==", true));
  const importedSalesSnap = await getDocs(importedSalesQuery);
  console.log(`Found ${importedSalesSnap.size} imported sales bills total.`);
  
  if (importedSalesSnap.size > 0) {
    const grouped = {};
    importedSalesSnap.forEach(doc => {
      const data = doc.data();
      const date = data.createdAt?.toDate ? data.createdAt.toDate().toDateString() : new Date(data.createdAt).toDateString();
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(doc.id);
    });
    console.log("\nImported bills grouped by creation date:");
    for (const [date, ids] of Object.entries(grouped)) {
      console.log(`- ${date}: ${ids.length} bills (IDs: ${ids.slice(0, 3).join(", ")}${ids.length > 3 ? '...' : ''})`);
    }
  }

  process.exit(0);
}
run().catch(err => {
  console.error(err);
  process.exit(1);
});
