import { type ProviderInteractionMode, type RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  traitsMenuContent?: ReactNode;
  interactionMode: ProviderInteractionMode;
  showInteractionModeToggle?: boolean;
  runtimeMode?: RuntimeMode;
  onToggleInteractionMode: () => void;
  onToggleRuntimeMode?: () => void;
}) {
  const showRuntimeControls =
    props.runtimeMode != null && typeof props.onToggleRuntimeMode === "function";
  const showInteractionModeToggle = props.showInteractionModeToggle ?? true;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
            type="button"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
          </>
        ) : null}
        {showRuntimeControls ? (
          <>
            {showInteractionModeToggle ? <MenuDivider /> : null}
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
            <MenuRadioGroup
              value={props.runtimeMode}
              onValueChange={(value) => {
                if (!value || value === props.runtimeMode) return;
                props.onToggleRuntimeMode?.();
              }}
            >
              <MenuRadioItem value="full-access">Full access</MenuRadioItem>
              <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
            </MenuRadioGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
