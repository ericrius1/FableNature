import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // top-level await (renderer.init) needs a newer target than vite's default
    target: 'esnext',
  },
  resolve: {
    // addons import bare "three"; point it at the WebGPU build so only
    // one copy of three.js ends up in the bundle
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
});
