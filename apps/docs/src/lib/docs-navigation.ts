export type NavItem = {
  title: string;
  href: string;
  external?: boolean;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

export const docsNavigation: NavSection[] = [
  {
    title: "Getting Started",
    items: [
      { title: "Introduction", href: "/" },
      { title: "Quick Start", href: "/quick-start" },
      { title: "Configuration", href: "/configuration" },
      { title: "Authenticated Targets", href: "/authenticated-targets" },
    ],
  },
  {
    title: "Reference",
    items: [
      { title: "Commands", href: "/commands" },
      { title: "Actions", href: "/actions" },
      { title: "Examples", href: "/examples" },
      { title: "Changelog", href: "/changelog" },
    ],
  },
];

export const allDocsPages = docsNavigation.flatMap((section) =>
  section.items.filter((item) => !item.external),
);
