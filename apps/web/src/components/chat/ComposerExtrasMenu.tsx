import { type ProviderInteractionMode } from "@t3tools/contracts";
import { ListTodoIcon, PaperclipIcon, PlusIcon, ZapIcon } from "lucide-react";
import { memo, useId, useRef, type ChangeEvent } from "react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";

export const ComposerExtrasMenu = memo(function ComposerExtrasMenu(props: {
  interactionMode: ProviderInteractionMode;
  showInteractionModeToggle?: boolean;
  supportsFastMode: boolean;
  fastModeEnabled: boolean;
  onAddPhotos: (files: File[]) => void;
  onSetFastMode: (enabled: boolean) => void;
  onSetPlanMode: (enabled: boolean) => void;
}) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      props.onAddPhotos(files);
    }
    event.target.value = "";
  };

  const showInteractionModeToggle = props.showInteractionModeToggle ?? true;

  return (
    <>
      <input
        id={inputId}
        ref={fileInputRef}
        data-testid="composer-photo-input"
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="sr-only"
        onChange={handleFileInputChange}
      />
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
              aria-label="Composer extras"
            />
          }
        >
          <PlusIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuItem
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            <PaperclipIcon className="size-4 shrink-0" />
            Add file
          </MenuItem>

          {showInteractionModeToggle ? (
            <>
              <MenuSeparator />
              <MenuCheckboxItem
                checked={props.interactionMode === "plan"}
                variant="switch"
                onCheckedChange={(checked) => {
                  props.onSetPlanMode(checked === true);
                }}
              >
                <span className="inline-flex items-center gap-2">
                  <ListTodoIcon className="size-4 shrink-0" />
                  Plan mode
                </span>
              </MenuCheckboxItem>
            </>
          ) : null}

          {props.supportsFastMode ? (
            <>
              <MenuSeparator />
              <MenuSub>
                <MenuSubTrigger>
                  <ZapIcon className="size-4 shrink-0" />
                  Fast
                </MenuSubTrigger>
                <MenuSubPopup>
                  <MenuRadioGroup
                    value={props.fastModeEnabled ? "fast" : "normal"}
                    onValueChange={(value) => {
                      props.onSetFastMode(value === "fast");
                    }}
                  >
                    <MenuRadioItem value="normal">Default</MenuRadioItem>
                    <MenuRadioItem value="fast">Fast</MenuRadioItem>
                  </MenuRadioGroup>
                </MenuSubPopup>
              </MenuSub>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </>
  );
});

