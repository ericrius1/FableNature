import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // addons import bare "three"; point it at the WebGPU build so only
    // one copy of three.js ends up in the bundle
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
});
