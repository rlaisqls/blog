import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'Binary Thoughts',
			social: {
				github: 'https://github.com/rlaisqls',
			},
			components: {
				Sidebar: './src/components/Sidebar.astro',
				Footer: './src/components/Footer.astro'
			},
			sidebar: [
				{
					label: 'Reference',
					autogenerate: { directory: 'reference' },
				},
				{
					label: 'TIL Git',
					collapsed: true,
					autogenerate: { directory: 'TIL' },
				},
			],
			customCss: ['./src/tailwind.css'],
		}),
		tailwind({ applyBaseStyles: false }),
	],
});
