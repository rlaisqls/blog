import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import remarkDescription from "astro-remark-description";
import { rehypeHeadingIds } from "@astrojs/markdown-remark";
import rehypeAutolinkHeadings from "rehype-autolink-headings";

// https://astro.build/config
export default defineConfig({
	site: "https://blog.rlaisqls.com",
	markdown: {
		rehypePlugins: [rehypeHeadingIds, rehypeAutolinkHeadings],
		remarkPlugins: [[remarkDescription, {}]],
	},
	integrations: [
		starlight({
			title: "Beside the Wheel",
			favicon: "favicon.png",
			social: [
				{
					icon: "email",
					label: "Email",
					href: "mailto:rlaisqls@gmail.com",
				},
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/rlaisqls",
				},
			],
			components: {
				Sidebar: "./src/components/Sidebar.astro",
				Footer: "./src/components/Footer.astro",
				PageTitle: "./src/components/PageTitle.astro",
				ThemeSelect: "./src/components/ThemeSelect.astro",
				Head: "./src/components/Head.astro",
				PageFrame: "./src/components/PageFrame.astro",
			},
			sidebar: [
				{
					label: "공부",
					items: [
						{ autogenerate: { directory: "thoughts/공부", collapsed: true } },
					],
				},
				{
					label: "TIL",
					items: [{ autogenerate: { directory: "TIL", collapsed: true } }],
				},
				{
					label: "독후감",
					items: [
						{ autogenerate: { directory: "thoughts/독후감", collapsed: true } },
					],
				},
				{
					label: "생각",
					items: [
						{ autogenerate: { directory: "thoughts/생각들", collapsed: true } },
					],
				},
				{
					label: "회고",
					items: [
						{ autogenerate: { directory: "thoughts/회고", collapsed: true } },
					],
				},
			],
			customCss: ["./src/tailwind.css"],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
