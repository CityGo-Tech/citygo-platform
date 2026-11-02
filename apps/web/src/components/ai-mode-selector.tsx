"use client";
import * as React from "react";
import { Button, SelectField } from "@citygo/ui-web";
import { aiModeIdSchema, type AiModeId, type AiModes } from "@citygo/contracts";
import { formatAiModeOptionLabel } from "@citygo/api-client";

export function AiModeSelector({
  modes,
  selected,
  disabled,
  onSelect,
}: {
  modes?: AiModes;
  selected: AiModeId;
  disabled: boolean;
  onSelect: (mode: AiModeId) => void;
}) {
  if (!modes) return null;
  const needsConsent = modes.options.some(
    (option) =>
      option.id === selected && option.available && option.consentRequired,
  );
  return (
    <>
      <SelectField
        className="ym-show-content"
        label="Режим работы"
        value={selected}
        disabled={disabled}
        onChange={(event) => {
          const mode = aiModeIdSchema.safeParse(event.target.value);
          if (
            !disabled &&
            mode.success &&
            modes.options.some(
              (option) => option.id === mode.data && option.available,
            )
          )
            onSelect(mode.data);
        }}
      >
        {modes.options.map((option) => (
          <option
            key={option.id}
            value={option.id}
            disabled={!option.available}
          >
            {formatAiModeOptionLabel(option)}
            {!option.available ? " — временно недоступен" : ""}
          </option>
        ))}
      </SelectField>
      {needsConsent && (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => onSelect(selected)}
        >
          Подтвердить выбор
        </Button>
      )}
    </>
  );
}
