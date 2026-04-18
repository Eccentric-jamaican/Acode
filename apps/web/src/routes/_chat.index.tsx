import { createFileRoute } from "@tanstack/react-router";

import ChatHomeSurface, {
  resolveChatHomeSurfaceVariant,
} from "../components/ChatHomeSurface";
import { useStore } from "../store";

function ChatIndexRouteView() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const variant = resolveChatHomeSurfaceVariant({
    projectsCount: projects.length,
    threadsCount: threads.length,
  });

  return <ChatHomeSurface variant={variant} />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
