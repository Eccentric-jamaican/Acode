import { createFileRoute } from "@tanstack/react-router";

import ChatHomeSurface, {
  resolveChatHomeSurfaceVariant,
} from "../components/ChatHomeSurface";
import { useStore } from "../store";

function ChatIndexRouteView() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const hydrationError = useStore((store) => store.hydrationError);
  if (!threadsHydrated) {
    return <ChatHomeSurface variant={hydrationError ? "error" : "hydrating"} />;
  }
  const variant = resolveChatHomeSurfaceVariant({
    projectsCount: projects.length,
    threadsCount: threads.length,
  });

  return <ChatHomeSurface variant={variant} />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
