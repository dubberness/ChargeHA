import { useState } from "react";
import { AlertDialog, Badge, Button, Select, Text } from "@radix-ui/themes";
import { Car, KeyRound, Pencil, Unplug } from "lucide-react";
import type { VehicleWithState } from "@chargeha/shared";
import { linkedChargingPointId } from "@chargeha/shared/chargingPoints";
import { FormError, SettingsRow } from "../../../hostUi.ts";
import { TessieTokenForm } from "./TessieTokenStep.tsx";
import { trpc } from "./trpc.ts";

const MIN_AMPS_OPTIONS = ["1", "2", "3", "4", "5"];

const MIN_AMPS_HELP =
  "Charging won't start below this. 5A matches the Tesla app. Cars on three " +
  "phase may accept less. This is undocumented.";

const sectionStyle = {
  marginTop: 12,
  paddingTop: 12,
  borderTop: "1px solid var(--gray-a4)",
};

const headingStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 8,
};

export function TessieChargerFields(
  { vin }: { vin: string },
): JSX.Element | null {
  const chargerRowId = linkedChargingPointId(vin);
  const utils = trpc.useUtils();
  const configQuery = trpc.plugin.vehicle.tessie.charger.getConfig.useQuery({
    chargerRowId,
  });
  const setConfig = trpc.plugin.vehicle.tessie.charger.setConfig.useMutation({
    onSuccess: () =>
      utils.plugin.vehicle.tessie.charger.getConfig.invalidate({
        chargerRowId,
      }),
  });

  if (!configQuery.data) return null;

  return (
    <div style={{ marginTop: 4 }}>
      <SettingsRow label="Min amps" help={MIN_AMPS_HELP}>
        <Select.Root
          size="1"
          value={configQuery.data.tessieMinAmps}
          onValueChange={(value) =>
            setConfig.mutate({
              chargerRowId,
              values: { tessieMinAmps: value },
            })}
        >
          <Select.Trigger aria-label="Min amps" />
          <Select.Content>
            {MIN_AMPS_OPTIONS.map((amps) => (
              <Select.Item key={amps} value={amps}>{amps}A</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </SettingsRow>
    </div>
  );
}

function TessieHeader({ tokenRejected }: { tokenRejected: boolean }) {
  return (
    <div style={headingStyle}>
      <Car size={14} />
      <Text size="2" weight="medium">Tessie</Text>
      {tokenRejected && <Badge color="red" size="1">Token rejected</Badge>}
      {!tokenRejected && <Badge color="green" size="1">Connected</Badge>}
    </div>
  );
}

function AccountVehicles(
  { accountVehicles, added, onAdd }: {
    accountVehicles: { vin: string; name: string }[];
    added: VehicleWithState[];
    onAdd: (vehicle: { vin: string; name: string }) => void;
  },
) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {accountVehicles.map((v) => {
        const isAdded = added.some((a) => a.id === v.vin);
        return (
          <div
            key={v.vin}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              background: "var(--gray-a2)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <Text size="2" weight="medium">{v.name}</Text>
                <Text size="1" color="gray" style={{ display: "block" }}>
                  {v.vin}
                </Text>
              </div>
              {isAdded && <Badge color="green" size="1">Added</Badge>}
              {!isAdded && (
                <Button
                  size="1"
                  variant="soft"
                  onClick={() => onAdd(v)}
                >
                  Add
                </Button>
              )}
            </div>
            {isAdded && <TessieChargerFields vin={v.vin} />}
          </div>
        );
      })}
    </div>
  );
}

function TokenBlock({ onSaved }: { onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const saveMutation = trpc.plugin.vehicle.tessie.setConfig.useMutation({
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
  });
  return (
    <div style={sectionStyle}>
      <div style={headingStyle}>
        <KeyRound size={14} />
        <Text size="2" weight="medium">API token</Text>
      </div>
      <SettingsRow
        label="Tessie API token"
        help="A replacement token is saved as soon as it passes the test."
      >
        <Button
          size="1"
          variant="soft"
          onClick={() => setEditing((open) => !open)}
        >
          <Pencil size={12} />
          {editing ? "Close" : "Replace"}
        </Button>
      </SettingsRow>
      {editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <TessieTokenForm
            onValidated={(token) =>
              saveMutation.mutate({ tessieApiToken: token })}
          />
          {saveMutation.error && (
            <FormError message={saveMutation.error.message} />
          )}
        </div>
      )}
    </div>
  );
}

function DisconnectBlock(
  { onDisconnect, pending }: { onDisconnect: () => void; pending: boolean },
) {
  return (
    <div style={sectionStyle}>
      <div style={headingStyle}>
        <Unplug size={14} />
        <Text size="2" weight="medium">Disconnect Tessie</Text>
      </div>
      <AlertDialog.Root>
        <AlertDialog.Trigger>
          <Button
            size="1"
            variant="soft"
            color="red"
            disabled={pending}
            style={{ marginBottom: 8 }}
          >
            Disconnect Tessie
          </Button>
        </AlertDialog.Trigger>
        <AlertDialog.Content maxWidth="420px">
          <AlertDialog.Title>Disconnect Tessie?</AlertDialog.Title>
          <AlertDialog.Description size="2">
            Your Tessie vehicles and API token will be removed from ChargeHA.
          </AlertDialog.Description>
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 16,
              justifyContent: "flex-end",
            }}
          >
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray">Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action>
              <Button color="red" onClick={onDisconnect}>Disconnect</Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <Text size="1" color="gray" style={{ display: "block" }}>
        Removes the vehicles and token from ChargeHA only. Nothing changes in
        your Tessie account.
      </Text>
    </div>
  );
}

export function TessieSettings(): JSX.Element {
  const utils = trpc.useUtils();
  const refreshAll = () => utils.plugin.vehicle.tessie.invalidate();
  const statusQuery = trpc.plugin.vehicle.tessie.tessieStatus.useQuery();
  const accountQuery = trpc.plugin.vehicle.tessie.tessieVehicles.useQuery(
    undefined,
    { enabled: statusQuery.data?.tokenConfigured === true },
  );
  const addedQuery = trpc.plugin.vehicle.tessie.listVehicles.useQuery();
  const selectMutation = trpc.plugin.vehicle.tessie.selectVehicles
    .useMutation({ onSuccess: refreshAll });
  const disconnectMutation = trpc.plugin.vehicle.tessie.disconnect
    .useMutation({ onSuccess: refreshAll });

  const added = addedQuery.data?.vehicles ?? [];
  const onAdd = (vehicle: { vin: string; name: string }) =>
    selectMutation.mutate({
      vehicles: [{ ...vehicle, priority: added.length + 1 }],
    });

  return (
    <div style={sectionStyle}>
      <TessieHeader tokenRejected={!!statusQuery.data?.tokenRejected} />
      {accountQuery.error && <FormError message={accountQuery.error.message} />}
      <AccountVehicles
        accountVehicles={accountQuery.data?.vehicles ?? []}
        added={added}
        onAdd={onAdd}
      />
      <TokenBlock onSaved={refreshAll} />
      <DisconnectBlock
        onDisconnect={() => disconnectMutation.mutate()}
        pending={disconnectMutation.isPending}
      />
    </div>
  );
}
