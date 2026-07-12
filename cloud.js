import "./alerts.js";

const FIREBASE_VERSION = "11.10.0";

function configIsReady(config) {
  if (!config || typeof config !== "object") return false;
  const required = ["apiKey", "authDomain", "projectId", "appId"];
  return required.every((key) => config[key] && !String(config[key]).includes("PASTE_"));
}

export function isCloudConfigured() {
  return configIsReady(window.FOCUS_GLASS_FIREBASE_CONFIG);
}

export async function createCloudSync(callbacks = {}) {
  const config = window.FOCUS_GLASS_FIREBASE_CONFIG;
  if (!configIsReady(config)) {
    return {
      configured: false,
      user: null,
      signIn: async () => { throw new Error("Firebaseが未設定です"); },
      register: async () => { throw new Error("Firebaseが未設定です"); },
      signOut: async () => {},
      saveSession: async () => {},
      saveSettings: async () => {},
      initialSync: async () => ({ sessions: [], settings: null }),
      destroy: () => {}
    };
  }

  callbacks.onStatus?.("loading");

  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appModule, authModule, firestoreModule] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`)
  ]);

  const app = appModule.initializeApp(config);
  const auth = authModule.getAuth(app);
  const db = firestoreModule.getFirestore(app);
  let user = auth.currentUser;
  let sessionsUnsubscribe = null;
  let settingsUnsubscribe = null;

  async function signIn(email, password) {
    const credential = await authModule.signInWithEmailAndPassword(auth, email, password);
    return credential.user;
  }

  async function register(email, password) {
    const credential = await authModule.createUserWithEmailAndPassword(auth, email, password);
    return credential.user;
  }

  async function signOut() {
    await authModule.signOut(auth);
  }

  async function saveSession(session) {
    if (!user) return;
    const ref = firestoreModule.doc(db, "users", user.uid, "sessions", session.id);
    await firestoreModule.setDoc(ref, session, { merge: true });
  }

  async function saveSettings(settings) {
    if (!user) return;
    const ref = firestoreModule.doc(db, "users", user.uid, "meta", "settings");
    await firestoreModule.setDoc(ref, settings, { merge: true });
  }

  async function initialSync(localSessions = [], localSettings = null) {
    if (!user) return { sessions: [], settings: null };

    if (localSessions.length) {
      const chunks = [];
      for (let i = 0; i < localSessions.length; i += 100) chunks.push(localSessions.slice(i, i + 100));
      for (const chunk of chunks) await Promise.all(chunk.map(saveSession));
    }

    const settingsRef = firestoreModule.doc(db, "users", user.uid, "meta", "settings");
    const settingsSnap = await firestoreModule.getDoc(settingsRef);
    const cloudSettings = settingsSnap.exists() ? settingsSnap.data() : null;

    if (localSettings && (!cloudSettings || (localSettings.updatedAt || 0) >= (cloudSettings.updatedAt || 0))) {
      await saveSettings(localSettings);
    }

    const sessionsQuery = firestoreModule.query(
      firestoreModule.collection(db, "users", user.uid, "sessions"),
      firestoreModule.orderBy("endedAt", "desc"),
      firestoreModule.limit(1000)
    );
    const sessionsSnap = await firestoreModule.getDocs(sessionsQuery);
    const sessions = sessionsSnap.docs.map((docSnap) => docSnap.data());

    return {
      sessions,
      settings: cloudSettings && (cloudSettings.updatedAt || 0) > (localSettings?.updatedAt || 0) ? cloudSettings : null
    };
  }

  function subscribe() {
    sessionsUnsubscribe?.();
    settingsUnsubscribe?.();
    if (!user) return;

    const sessionsQuery = firestoreModule.query(
      firestoreModule.collection(db, "users", user.uid, "sessions"),
      firestoreModule.orderBy("endedAt", "desc"),
      firestoreModule.limit(1000)
    );

    sessionsUnsubscribe = firestoreModule.onSnapshot(sessionsQuery, (snapshot) => {
      callbacks.onSessions?.(snapshot.docs.map((docSnap) => docSnap.data()));
    }, (error) => callbacks.onError?.(error));

    const settingsRef = firestoreModule.doc(db, "users", user.uid, "meta", "settings");
    settingsUnsubscribe = firestoreModule.onSnapshot(settingsRef, (snapshot) => {
      if (snapshot.exists()) callbacks.onSettings?.(snapshot.data());
    }, (error) => callbacks.onError?.(error));
  }

  const authReady = new Promise((resolve) => {
    authModule.onAuthStateChanged(auth, (nextUser) => {
      user = nextUser;
      callbacks.onAuth?.(user);
      subscribe();
      resolve(user);
    });
  });
  await authReady;
  callbacks.onStatus?.("ready");

  return {
    configured: true,
    get user() { return user; },
    signIn,
    register,
    signOut,
    saveSession,
    saveSettings,
    initialSync,
    destroy() { sessionsUnsubscribe?.(); settingsUnsubscribe?.(); }
  };
}
