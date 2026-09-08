import type { Meta, StoryObj } from "@storybook/react-vite";
import { type JSX, useState } from "react";
import { fn } from "storybook/test";
import { noop, SCREENS } from "./fixtures.ts";
import { ShellFrame } from "./shell.tsx";
import type { Actions, Screen } from "./types.ts";

/** Every action as a spy, so a click shows up in the Actions panel instead of vanishing. */
const actions = Object.fromEntries(
  Object.keys(noop).map((name) => [name, fn().mockName(name)]),
) as unknown as Actions;

const meta = {
  title: "Screens",
  component: ShellFrame,
  args: { actions },
} satisfies Meta<typeof ShellFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

const of = (screen: Screen): Story => ({ args: { screen } });

export const Home = of(SCREENS["home"]);
export const HomeFirstRun = of(SCREENS["home-first-run"]);
export const HomeError = of(SCREENS["home-error"]);
export const Connecting = of(SCREENS["connecting"]);
export const Starting = of(SCREENS["starting"]);
export const Accept = of(SCREENS["accept"]);
export const Pair = of(SCREENS["pair"]);
export const PairAgain = of(SCREENS["pair-again"]);
export const PairRefused = of(SCREENS["pair-refused"]);
export const Trust = of(SCREENS["trust"]);
export const Library = of(SCREENS["library"]);
export const LibraryEmpty = of(SCREENS["library-empty"]);
export const LibraryLoading = of(SCREENS["library-loading"]);
export const Streaming = of(SCREENS["streaming"]);
export const StreamingDiagnostics = of(SCREENS["streaming-diagnostics"]);
export const StreamingCaptured = of(SCREENS["streaming-captured"]);
export const ErrorCard = of(SCREENS["error"]);

/** The one screen with controls that must visibly respond, so it keeps a copy of its values. */
export const Settings: Story = {
  args: { screen: SCREENS["settings"] },
  render: ({ actions }) => <LiveSettings actions={actions} />,
};

function LiveSettings({ actions }: { actions: Actions }): JSX.Element {
  const [screen, setScreen] = useState(SCREENS["settings"]);
  return (
    <ShellFrame
      screen={screen}
      actions={{
        ...actions,
        setSettings: (patch) => {
          actions.setSettings(patch);
          setScreen((s) => ({ ...s, values: { ...s.values, ...patch } }));
        },
      }}
    />
  );
}
