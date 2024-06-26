import colors from 'tailwindcss/colors';
import starlightPlugin from '@astrojs/starlight-tailwind';

/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
	theme: {
		extend: {
			colors: {
				accent: {
				  '50': '#ffffff',
				  '100': '#ffffff',
				  '200': '#ffffff',
				  '300': '#ffffff',
				  '400': '#ffffff',
				  '500': '#000000',
				  '600': '#000000',
				  '700': '#000000',
				  '800': '#000000',
				  '900': '#000000',
				  '950': '#000000'
				},
				gray: colors.zinc,
			},
		},
	},
	plugins: [starlightPlugin(), require("tailwind-scrollbar-hide")],
};
