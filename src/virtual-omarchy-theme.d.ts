declare module "virtual:omarchy-theme" {
  export const omarchyTheme: {
    enabled: boolean;
    mode: "light" | "dark";
    name: string;
    background: string;
    foreground: string;
    accent: string;
    css: string;
  };
}
