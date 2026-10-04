import { Switch, Text } from "@radix-ui/themes";
import type { ScheduleFormData } from "@chargeha/shared";
import styles from "./ScheduleDialog.module.css";

interface BlockoutSettingsProps {
  allowSolar: boolean;
  updateField: <K extends keyof ScheduleFormData>(
    key: K,
    value: ScheduleFormData[K],
  ) => void;
}

// Blockout schedules only.
export function BlockoutSettings(
  { allowSolar, updateField }: BlockoutSettingsProps,
) {
  return (
    <div className={styles.field}>
      <Text as="label" size="2" weight="medium">
        <Switch
          size="1"
          checked={allowSolar}
          onCheckedChange={(checked) => updateField("allowSolar", checked)}
          style={{ marginRight: 8, verticalAlign: "middle" }}
        />
        Allow solar charging
      </Text>
      <Text size="1" color="gray">
        Still charges from spare solar during the blockout, but never from the
        grid. It waits for the solar to hold steady before starting, keeps a
        little in reserve, and stops within seconds if the solar falls short.
      </Text>
    </div>
  );
}
