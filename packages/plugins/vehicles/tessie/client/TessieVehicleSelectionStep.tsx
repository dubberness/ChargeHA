import { useEffect, useState } from "react";
import { Callout, Checkbox, Text, TextField } from "@radix-ui/themes";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import {
  advanceOnly,
  type PluginStepDef,
  stepStyles as styles,
  type WizardNext,
} from "../../../hostUi.ts";
import { trpc } from "./trpc.ts";

type AccountVehicle = { vin: string; name: string };

// Save what was picked, carry on with vehicles saved earlier, or pick first.
export function selectionNext(
  { loading, selectedCount, existingCount, save }: {
    loading: boolean;
    selectedCount: number;
    existingCount: number;
    save: () => Promise<void>;
  },
): WizardNext {
  if (loading) return { kind: "loading" };
  if (selectedCount > 0) {
    return {
      kind: "ready",
      hint: "Next saves the selected vehicles",
      onNext: save,
    };
  }
  if (existingCount > 0) {
    return {
      kind: "ready",
      hint: "Vehicles already configured — Next continues",
      onNext: advanceOnly,
    };
  }
  return { kind: "blocked", reason: "Select at least one vehicle to continue" };
}

function VehicleOption(
  { vehicle, selected, showPriority, priority, onToggle, onPriority }: {
    vehicle: AccountVehicle;
    selected: boolean;
    showPriority: boolean;
    priority: number;
    onToggle: () => void;
    onPriority: (value: string) => void;
  },
) {
  return (
    <div
      className={`${styles.vehicleRow} ${
        selected ? styles.vehicleRowSelected : ""
      }`}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={onToggle}
        aria-label={`Select ${vehicle.name}`}
      />
      <div className={styles.vehicleInfo}>
        <Text weight="medium">{vehicle.name}</Text>
        <Text size="1" color="gray">VIN: {vehicle.vin}</Text>
      </div>
      {showPriority && (
        <div className={styles.priorityInput}>
          <Text size="1" color="gray">Priority</Text>
          <TextField.Root
            type="number"
            value={String(priority)}
            onChange={(e: { target: { value: string } }) =>
              onPriority(e.target.value)}
            style={{ width: 60 }}
            aria-label={`Priority for ${vehicle.name}`}
          />
        </div>
      )}
    </div>
  );
}

function useTessieVehicleSelection() {
  const utils = trpc.useUtils();
  const existingQuery = trpc.plugin.vehicle.tessie.listVehicles.useQuery();
  const accountQuery = trpc.plugin.vehicle.tessie.tessieVehicles.useQuery();
  const vehicles: AccountVehicle[] = accountQuery.data?.vehicles ?? [];
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [priorities, setPriorities] = useState<Record<string, number>>({});

  // Everything starts selected, in account order, once the list arrives.
  useEffect(() => {
    if (selected !== null || vehicles.length === 0) return;
    setSelected(new Set(vehicles.map((v) => v.vin)));
    setPriorities(Object.fromEntries(vehicles.map((v, i) => [v.vin, i + 1])));
  }, [vehicles, selected]);

  const chosen = selected ?? new Set<string>();
  const toggle = (vin: string) =>
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(vin)) next.delete(vin);
      else next.add(vin);
      return next;
    });
  const setPriority = (vin: string, value: string) => {
    const num = parseInt(value, 10);
    if (num > 0) setPriorities((prev) => ({ ...prev, [vin]: num }));
  };
  const save = async () => {
    await utils.client.plugin.vehicle.tessie.selectVehicles.mutate({
      vehicles: vehicles.filter((v) => chosen.has(v.vin)).map((v) => ({
        vin: v.vin,
        name: v.name,
        priority: priorities[v.vin] ?? 1,
      })),
    });
    await utils.plugin.vehicle.tessie.listVehicles.invalidate();
  };

  return {
    vehicles,
    chosen,
    priorities,
    toggle,
    setPriority,
    save,
    existingCount: existingQuery.data?.vehicles.length ?? 0,
    loading: accountQuery.isLoading || existingQuery.isLoading,
    error: accountQuery.error?.message ?? null,
  };
}

function SelectionView(
  {
    vehicles,
    chosen,
    priorities,
    toggle,
    setPriority,
    existingCount,
    loading,
    error,
  }: ReturnType<typeof useTessieVehicleSelection>,
) {
  return (
    <div className={styles.stepContainer}>
      <Text as="p" size="3" color="gray">
        Select the vehicles you want ChargeHA to manage. These are the active
        vehicles on your Tessie account.
      </Text>
      {existingCount > 0 && (
        <Callout.Root color="green">
          <Callout.Icon>
            <CheckCircle size={16} />
          </Callout.Icon>
          <Callout.Text>Vehicles are already configured.</Callout.Text>
        </Callout.Root>
      )}
      {loading && (
        <Callout.Root color="blue">
          <Callout.Icon>
            <Loader2 size={16} className={styles.spinner} />
          </Callout.Icon>
          <Callout.Text>Loading vehicles from Tessie...</Callout.Text>
        </Callout.Root>
      )}
      {error && (
        <Callout.Root color="red">
          <Callout.Icon>
            <AlertCircle size={16} />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      {!loading && !error && vehicles.length === 0 && (
        <Callout.Root color="orange">
          <Callout.Text>
            No active vehicles on your Tessie account.
          </Callout.Text>
        </Callout.Root>
      )}
      {vehicles.length > 0 && (
        <div className={styles.vehicleList}>
          {vehicles.map((vehicle) => (
            <VehicleOption
              key={vehicle.vin}
              vehicle={vehicle}
              selected={chosen.has(vehicle.vin)}
              showPriority={chosen.size > 1}
              priority={priorities[vehicle.vin] ?? 1}
              onToggle={() => toggle(vehicle.vin)}
              onPriority={(value) => setPriority(vehicle.vin, value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const tessieVehicleSelectionStep: PluginStepDef = {
  id: "tessie-vehicle-selection",
  label: "Vehicle Selection",
  useStep: () => {
    const selection = useTessieVehicleSelection();
    return {
      next: selectionNext({
        loading: selection.loading,
        selectedCount: selection.chosen.size,
        existingCount: selection.existingCount,
        save: selection.save,
      }),
      view: <SelectionView {...selection} />,
    };
  },
};
