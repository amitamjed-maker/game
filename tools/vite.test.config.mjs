// টেস্টের জন্য: আসল Firebase-এর বদলে মেমরির নকল Firebase। চালাতে: npx vite --config tools/vite.test.config.mjs
import path from 'path';
const m = path.resolve('tools/fb-mock.js');
export default { base: './', resolve: { alias: { 'firebase/app': m, 'firebase/database': m } }, server: { port: 5199, host: '127.0.0.1' } };
