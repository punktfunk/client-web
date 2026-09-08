// The page's real stylesheet, so a story is drawn by the same rules as the client.
import "../src/styles.css";
import { definePreview } from "@storybook/react-vite";
import { useEffect } from "react";

export default definePreview({
  addons: [],
  parameters: {
    // Every screen is `fixed inset-0`: it owns the viewport, and a padded canvas would only
    // show as a strip around it.
    layout: "fullscreen",
    backgrounds: { disable: true },
  },
  decorators: [
    (Story) => {
      // `index.html` pins `<html class="dark">`; @unom/ui's `dark:` variants key on it.
      // The client has no light theme to switch to, so there is no toolbar for one.
      useEffect(() => {
        document.documentElement.classList.add("dark");
      }, []);
      return <Story />;
    },
  ],
});
