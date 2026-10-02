import { getInjectable2 } from "@k8slens/injectable";
import { computed, type IComputedValue, observable, runInAction } from "mobx";

export interface InspectedPod {
  readonly uid: string;
  readonly name: string;
  readonly namespace: string;
  /** Growing out of its box, filling the page, or shrinking back into its box. */
  readonly phase: "expanding" | "expanded" | "collapsing";
}

export interface PodInspection {
  readonly inspected: IComputedValue<InspectedPod | undefined>;
  readonly inspect: (pod: Pick<InspectedPod, "uid" | "name" | "namespace">) => void;
  readonly close: () => void;
  /** For the `$ref` of a pod's box: where the expanded pod grows out of and shrinks back into. */
  readonly tileRef: (uid: string) => (element: HTMLElement | null) => void;
  /** For the `$ref` of the expanded pod, positioned within the same container as the boxes. */
  readonly expandedRef: (element: HTMLElement | null) => void;
}

interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

const duration = 420;
const easing = "cubic-bezier(0.2, 0.9, 0.1, 1)";

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const rectWithin = (element: HTMLElement, container: HTMLElement): Rect => {
  const rect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  return { top: rect.top - containerRect.top, left: rect.left - containerRect.left, width: rect.width, height: rect.height };
};

const toKeyframe = ({ top, left, width, height }: Rect): Keyframe => ({
  top: `${top}px`,
  left: `${left}px`,
  width: `${width}px`,
  height: `${height}px`,
});

/** Which pod of a cluster's Inspect Pods page is expanded, and the animation between its box and the page. */
export const podInspectionInjectable = getInjectable2({
  id: "inspect-pod-inspection",

  instantiate: () => (_clusterId: string): PodInspection => {
    const inspected = observable.box<InspectedPod | undefined>(undefined, { deep: false });
    const tiles = new Map<string, HTMLElement>();
    const tileRefs = new Map<string, (element: HTMLElement | null) => void>();
    let expandedElement: HTMLElement | null = null;
    let animation: Animation | undefined;

    // Resolves with whether the animation ran to its end, rather than being cut short by another.
    const animate = (element: HTMLElement, keyframes: Keyframe[], fill: FillMode): Promise<boolean> => {
      animation?.cancel();

      if (prefersReducedMotion()) {
        return Promise.resolve(true);
      }

      const current = element.animate(keyframes, { duration, easing, fill });

      animation = current;

      return current.finished.then(
        () => true,
        () => false,
      );
    };

    const setInspected = (value: InspectedPod | undefined) => runInAction(() => inspected.set(value));

    const expand = (element: HTMLElement, expanding: InspectedPod) => {
      const container = element.parentElement;
      const tile = tiles.get(expanding.uid);

      element.focus({ preventScroll: true });

      const grown = container && tile
        ? animate(element, [toKeyframe(rectWithin(tile, container)), toKeyframe(rectWithin(element, container))], "none")
        : animate(element, [{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], "none");

      void grown.then((finished) => {
        if (finished && inspected.get() === expanding) {
          setInspected({ ...expanding, phase: "expanded" });
        }
      });
    };

    const close = () => {
      const current = inspected.get();

      if (!current || current.phase === "collapsing") {
        return;
      }

      const collapsing: InspectedPod = { ...current, phase: "collapsing" };
      const element = expandedElement;
      const container = element?.parentElement;
      const tile = tiles.get(current.uid);

      setInspected(collapsing);

      if (!element || !container) {
        setInspected(undefined);

        return;
      }

      const shrunk = tile
        ? animate(element, [toKeyframe(rectWithin(element, container)), toKeyframe(rectWithin(tile, container))], "forwards")
        : animate(element, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.96)" }], "forwards");

      void shrunk.then((finished) => {
        if (finished && inspected.get() === collapsing) {
          setInspected(undefined);
          // Back to the box it came from, once that is shown again.
          requestAnimationFrame(() => tile?.focus({ preventScroll: true }));
        }
      });
    };

    return {
      inspected: computed(() => inspected.get()),

      inspect: (pod) => {
        // A pod still shrinking back stops where it is, and the new one grows.
        animation?.cancel();
        setInspected({ ...pod, phase: "expanding" });
      },

      close,

      tileRef: (uid) => {
        let ref = tileRefs.get(uid);

        if (!ref) {
          ref = (element) => {
            if (element) {
              tiles.set(uid, element);
            } else {
              tiles.delete(uid);
              tileRefs.delete(uid);
            }
          };

          tileRefs.set(uid, ref);
        }

        return ref;
      },

      expandedRef: (element) => {
        expandedElement = element;

        const current = inspected.get();

        if (element) {
          if (current?.phase === "expanding") {
            expand(element, current);
          }
        } else {
          animation?.cancel();

          // The page went away mid-way through shrinking back: nothing is left to finish it.
          if (current?.phase === "collapsing") {
            setInspected(undefined);
          }
        }
      },
    };
  },
});
