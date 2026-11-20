export default {
  base: './',
  build: {
    outDir: 'dist', target: 'es2018', chunkSizeWarningLimit: 2000,
    rollupOptions: { output: { manualChunks: { three: ['three'], firebase: ['firebase/app', 'firebase/database'] } } }
  }
};
