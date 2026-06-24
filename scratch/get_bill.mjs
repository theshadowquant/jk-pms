import { initializeApp } from "firebase/app";
import { getFirestore, collection, query, limit, getDocs } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCh-tCXGbS3oAHLlBlufQYeElZ2TGgfMLE",
  authDomain: "jk-pms.firebaseapp.com",
  projectId: "jk-pms",
  storageBucket: "jk-pms.firebasestorage.app",
  messagingSenderId: "402199134787",
  appId: "1:402199134787:web:b42d8954a1cd4bb33a8af6",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  const q = query(collection(db, "sales"), limit(5));
  const snap = await getDocs(q);
  if (snap.empty) {
    console.log("No sales found in database.");
  } else {
    snap.forEach(doc => {
      console.log("ID:", doc.id, "=> Bill:", doc.data().billNumber, "Total:", doc.data().grandTotal);
    });
  }
  process.exit(0);
}
run().catch(err => {
  console.error(err);
  process.exit(1);
});
