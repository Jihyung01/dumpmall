import webpush from "web-push";
// Prints a fresh VAPID key pair. Add both to Vercel Production (private key as
// Sensitive) as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, then redeploy.
const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("VAPID_SUBJECT=https://dumpmall.com");
