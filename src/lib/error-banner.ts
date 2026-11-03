import { chatBannerError } from "./error-text";

export function createErrorBanner(publish: (message: string | null) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => clearTimeout(timer);
  return {
    dispose,
    show(cause: unknown) {
      const message = chatBannerError(cause);
      if (!message) return;
      dispose();
      publish(message);
      timer = setTimeout(() => publish(null), 6000);
    },
  };
}
