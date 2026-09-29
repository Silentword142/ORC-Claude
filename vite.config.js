import { defineConfig } from 'vite';

// base './' để có thể mở bản build từ bất kỳ thư mục/đường dẫn nào
// (GitHub Pages, máy chủ nội bộ, ổ đĩa mạng…)
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
