import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";

import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
    getFirestore
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
    getStorage
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-storage.js";


const firebaseConfig = {
    apiKey: "AIzaSyDd43TsFijT8zwyzlWlaikYMdrxNOeOabo",
    authDomain: "something-gamer.firebaseapp.com",
    projectId: "something-gamer",
    storageBucket: "something-gamer.firebasestorage.app",
    messagingSenderId: "1070139990422",
    appId: "1:1070139990422:web:45697a1f96ef4d03ae7db7",
    measurementId: "G-2NQJ3KDY5F"
};


const app = initializeApp(firebaseConfig);

const auth = getAuth(app);

const db = getFirestore(app);

const storage = getStorage(app);

const googleProvider = new GoogleAuthProvider();


export {
    auth,
    db,
    storage,
    googleProvider,
    signInWithPopup
};
