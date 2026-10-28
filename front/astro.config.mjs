// Storefront frontend (SF-10). SSR output: every page renders server-side
// against the commerce-os API; interactive islands arrive in SF-11.
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
});
