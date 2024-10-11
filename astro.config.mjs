import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwind from "@astrojs/tailwind";
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
			social: {
				github: "https://github.com/rlaisqls",
				linkedin:
					"https://www.linkedin.com/in/%EC%9D%80%EB%B9%88-%EA%B9%80-248452250/",
			},
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
					label: "글",
					autogenerate: { directory: "thoughts", collapsed: true },
				},
				{
					label: "TIL",
					autogenerate: { directory: "TIL", collapsed: true },
				},
			],
			customCss: ["./src/tailwind.css"],
		}),
		tailwind({ applyBaseStyles: false }),
	],
});
