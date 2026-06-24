const { initializeApp } = require("firebase/app");
const { getFirestore, collection, query, where, getDocs } = require("firebase/firestore");

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
  const q = query(collection(db, "sales"), where("billNumber", "==", "Bill-1046"));
  const snap = await getDocs(q);
  snap.forEach(doc => {
    console.log(doc.id, "=>", JSON.stringify(doc.data(), null, 2));
  });
  process.exit(0);
}
run().catch(err => {
  console.error(err);
  process.exit(1);
});
