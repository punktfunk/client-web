// The client's Slider IS @unom/ui's elastic slider, with the same correction the Select needs:
// its track is drawn `border-main`, the foreground colour — a near-white 1px frame that shouts
// next to the `border-input` every field beside it uses. The track is the wrapper's only child.
import { ElasticSlider, type ElasticSliderProps } from "@unom/ui/elastic-slider";
import { cn } from "@unom/ui/lib/utils";

export const Slider = ({ className, ...props }: ElasticSliderProps) => (
  <ElasticSlider className={cn("[&>div]:border-input", className)} {...props} />
);
Slider.displayName = "Slider";
