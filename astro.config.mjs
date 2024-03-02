import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
	site: 'https://blog.rlaisqls.site',
	integrations: [
		starlight({
			title: 'Binary Thoughts',
			social: {
				github: 'https://github.com/rlaisqls',
			},
			components: {
				Sidebar: './src/components/Sidebar.astro',
				Footer: './src/components/Footer.astro',
				PageTitle: './src/components/PageTitle.astro'
			},
			sidebar: [
				{
					label: '글',
					autogenerate: { directory: 'thoughts', collapsed: true },
				},
				{
					label: 'TIL',
					autogenerate: { directory: 'TIL/개발', collapsed: true },
				}
			],
			customCss: ['./src/tailwind.css'],
		}),
		tailwind({ applyBaseStyles: false }),
	],
});
