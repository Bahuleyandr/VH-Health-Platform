"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  LOCATION_KINDS,
  LOCATION_STATUSES,
  ROOM_KINDS,
  ROOM_STATUSES,
  listFacilityLocations,
  listFacilityRooms,
  saveFacilityLocation,
  saveFacilityRoom,
  type Facility,
  type FacilityLocation,
  type FacilityLocationPayload,
  type FacilityRoom,
  type FacilityRoomPayload,
} from "@/lib/api/facilityMasters";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DoorOpen, MapPin, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import {
  FormDialog,
  SelectInput,
  StatusPill,
  TextInput,
  optionalNumber,
  optionalText,
  toEnumOptions,
} from "./shared";

interface LocationForm {
  id: number | null;
  location_code: string;
  display_name: string;
  location_kind: string;
  parent_id: string;
  floor: string;
  building: string;
  status: string;
  capacity_hint: string;
}

interface RoomForm {
  id: number | null;
  location_id: string;
  room_code: string;
  display_name: string;
  room_kind: string;
  bed_capacity: string;
  floor: string;
  status: string;
}

const blankLocation: LocationForm = {
  id: null,
  location_code: "",
  display_name: "",
  location_kind: "ward",
  parent_id: "",
  floor: "",
  building: "",
  status: "active",
  capacity_hint: "",
};

const blankRoom: RoomForm = {
  id: null,
  location_id: "",
  room_code: "",
  display_name: "",
  room_kind: "general",
  bed_capacity: "",
  floor: "",
  status: "active",
};

export function StructureTab({
  facilities,
  facilityId,
  onSelectFacility,
}: {
  facilities: Facility[];
  facilityId: number | null;
  onSelectFacility: (facilityId: number | null) => void;
}) {
  const queryClient = useQueryClient();
  const [locationForm, setLocationForm] = useState<LocationForm | null>(null);
  const [roomForm, setRoomForm] = useState<RoomForm | null>(null);

  const locationsQuery = useQuery({
    queryKey: ["facility-masters", "locations", facilityId],
    queryFn: () =>
      listFacilityLocations({
        facility_id: facilityId ?? undefined,
        limit: 200,
      }),
    enabled: facilityId != null,
  });
  const roomsQuery = useQuery({
    queryKey: ["facility-masters", "rooms", facilityId],
    queryFn: () =>
      listFacilityRooms({ facility_id: facilityId ?? undefined, limit: 200 }),
    enabled: facilityId != null,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["facility-masters"] });

  const locationMutation = useMutation({
    mutationFn: (payload: FacilityLocationPayload) =>
      saveFacilityLocation(payload),
    onSuccess: () => {
      toast.success("Location saved");
      setLocationForm(null);
      void refresh();
    },
    onError: (err: Error) => toast.error(err.message || "Location save failed"),
  });

  const roomMutation = useMutation({
    mutationFn: (payload: FacilityRoomPayload) => saveFacilityRoom(payload),
    onSuccess: () => {
      toast.success("Room saved");
      setRoomForm(null);
      void refresh();
    },
    onError: (err: Error) => toast.error(err.message || "Room save failed"),
  });

  const locations = locationsQuery.data?.locations ?? [];
  const rooms = roomsQuery.data?.rooms ?? [];
  const locationLabel = (id: number | null) => {
    if (id == null) return "-";
    const match = locations.find((location) => location.id === id);
    return match ? match.display_name : `#${id}`;
  };

  const submitLocation = () => {
    if (!locationForm || facilityId == null) return;
    if (
      !locationForm.location_code.trim() ||
      !locationForm.display_name.trim()
    ) {
      toast.error("Location code and display name are required");
      return;
    }
    locationMutation.mutate({
      ...(locationForm.id != null ? { id: locationForm.id } : {}),
      facility_id: facilityId,
      parent_id: optionalNumber(locationForm.parent_id),
      location_code: locationForm.location_code.trim(),
      display_name: locationForm.display_name.trim(),
      location_kind:
        locationForm.location_kind as FacilityLocationPayload["location_kind"],
      floor: optionalText(locationForm.floor),
      building: optionalText(locationForm.building),
      status: locationForm.status as FacilityLocationPayload["status"],
      capacity_hint: optionalNumber(locationForm.capacity_hint),
    });
  };

  const submitRoom = () => {
    if (!roomForm || facilityId == null) return;
    const locationId = optionalNumber(roomForm.location_id);
    if (
      !roomForm.room_code.trim() ||
      !roomForm.display_name.trim() ||
      locationId == null
    ) {
      toast.error("Room code, display name, and location are required");
      return;
    }
    roomMutation.mutate({
      ...(roomForm.id != null ? { id: roomForm.id } : {}),
      facility_id: facilityId,
      location_id: locationId,
      room_code: roomForm.room_code.trim(),
      display_name: roomForm.display_name.trim(),
      room_kind: roomForm.room_kind as FacilityRoomPayload["room_kind"],
      bed_capacity: optionalNumber(roomForm.bed_capacity),
      floor: optionalText(roomForm.floor),
      status: roomForm.status as FacilityRoomPayload["status"],
    });
  };

  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <SelectInput
          label="Facility"
          value={facilityId != null ? String(facilityId) : ""}
          onChange={(v) => onSelectFacility(v ? Number(v) : null)}
          options={[
            { value: "", label: "Select a facility..." },
            ...facilities.map((facility) => ({
              value: String(facility.id),
              label: `${facility.display_name} (${facility.facility_code})`,
            })),
          ]}
        />
      </div>

      {facilityId == null ? (
        <EmptyState
          icon={<MapPin className="h-10 w-10 text-muted-foreground" />}
          title="Select a facility"
          description="Locations and rooms are scoped to one facility."
        />
      ) : locationsQuery.isLoading || roomsQuery.isLoading ? (
        <LoadingSpinner label="Loading structure..." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <section className="rounded-md border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-semibold">Locations</span>
              <button
                type="button"
                onClick={() => setLocationForm({ ...blankLocation })}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
              >
                <Plus className="h-3 w-3" />
                New location
              </button>
            </div>
            {locations.length === 0 ? (
              <EmptyState
                compact
                title="No locations"
                description="Add wards, OPD zones, labs, and other zones."
              />
            ) : (
              <div className="divide-y divide-border">
                {locations.map((location: FacilityLocation) => (
                  <div
                    key={location.id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <div>
                      <div className="font-medium text-foreground">
                        {location.display_name}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {location.location_code}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {location.location_kind.replace(/_/g, " ")}
                        {location.parent_id != null &&
                          ` · under ${locationLabel(location.parent_id)}`}
                        {location.floor && ` · floor ${location.floor}`}
                        {location.capacity_hint != null &&
                          ` · cap ${location.capacity_hint}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill value={location.status} />
                      <button
                        type="button"
                        onClick={() =>
                          setLocationForm({
                            id: location.id,
                            location_code: location.location_code,
                            display_name: location.display_name,
                            location_kind: location.location_kind,
                            parent_id:
                              location.parent_id != null
                                ? String(location.parent_id)
                                : "",
                            floor: location.floor ?? "",
                            building: location.building ?? "",
                            status: location.status,
                            capacity_hint:
                              location.capacity_hint != null
                                ? String(location.capacity_hint)
                                : "",
                          })
                        }
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-md border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-semibold">Rooms</span>
              <button
                type="button"
                onClick={() => setRoomForm({ ...blankRoom })}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
              >
                <Plus className="h-3 w-3" />
                New room
              </button>
            </div>
            {rooms.length === 0 ? (
              <EmptyState
                compact
                icon={<DoorOpen className="h-8 w-8 text-muted-foreground" />}
                title="No rooms"
                description="Rooms attach to a location within this facility."
              />
            ) : (
              <div className="divide-y divide-border">
                {rooms.map((room: FacilityRoom) => (
                  <div
                    key={room.id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <div>
                      <div className="font-medium text-foreground">
                        {room.display_name}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {room.room_code}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {room.room_kind.replace(/_/g, " ")} ·{" "}
                        {locationLabel(room.location_id)}
                        {room.bed_capacity != null &&
                          ` · ${room.bed_capacity} beds`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill value={room.status} />
                      <button
                        type="button"
                        onClick={() =>
                          setRoomForm({
                            id: room.id,
                            location_id: String(room.location_id),
                            room_code: room.room_code,
                            display_name: room.display_name,
                            room_kind: room.room_kind,
                            bed_capacity:
                              room.bed_capacity != null
                                ? String(room.bed_capacity)
                                : "",
                            floor: room.floor ?? "",
                            status: room.status,
                          })
                        }
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {locationForm && (
        <FormDialog
          title={locationForm.id != null ? "Edit location" : "New location"}
          onClose={() => setLocationForm(null)}
          onSubmit={submitLocation}
          pending={locationMutation.isPending}
        >
          <TextInput
            label="Location code"
            value={locationForm.location_code}
            onChange={(v) =>
              setLocationForm({ ...locationForm, location_code: v })
            }
          />
          <TextInput
            label="Location name"
            value={locationForm.display_name}
            onChange={(v) =>
              setLocationForm({ ...locationForm, display_name: v })
            }
          />
          <SelectInput
            label="Location kind"
            value={locationForm.location_kind}
            onChange={(v) =>
              setLocationForm({ ...locationForm, location_kind: v })
            }
            options={toEnumOptions(LOCATION_KINDS)}
          />
          <SelectInput
            label="Parent location"
            value={locationForm.parent_id}
            onChange={(v) => setLocationForm({ ...locationForm, parent_id: v })}
            options={[
              { value: "", label: "None (top level)" },
              ...locations
                .filter((location) => location.id !== locationForm.id)
                .map((location) => ({
                  value: String(location.id),
                  label: location.display_name,
                })),
            ]}
          />
          <TextInput
            label="Floor"
            value={locationForm.floor}
            onChange={(v) => setLocationForm({ ...locationForm, floor: v })}
          />
          <TextInput
            label="Building"
            value={locationForm.building}
            onChange={(v) => setLocationForm({ ...locationForm, building: v })}
          />
          <SelectInput
            label="Location status"
            value={locationForm.status}
            onChange={(v) => setLocationForm({ ...locationForm, status: v })}
            options={toEnumOptions(LOCATION_STATUSES)}
          />
          <TextInput
            label="Capacity hint"
            value={locationForm.capacity_hint}
            onChange={(v) =>
              setLocationForm({ ...locationForm, capacity_hint: v })
            }
          />
        </FormDialog>
      )}

      {roomForm && (
        <FormDialog
          title={roomForm.id != null ? "Edit room" : "New room"}
          onClose={() => setRoomForm(null)}
          onSubmit={submitRoom}
          pending={roomMutation.isPending}
        >
          <TextInput
            label="Room code"
            value={roomForm.room_code}
            onChange={(v) => setRoomForm({ ...roomForm, room_code: v })}
          />
          <TextInput
            label="Room name"
            value={roomForm.display_name}
            onChange={(v) => setRoomForm({ ...roomForm, display_name: v })}
          />
          <SelectInput
            label="Location"
            value={roomForm.location_id}
            onChange={(v) => setRoomForm({ ...roomForm, location_id: v })}
            options={[
              { value: "", label: "Select location..." },
              ...locations.map((location) => ({
                value: String(location.id),
                label: location.display_name,
              })),
            ]}
          />
          <SelectInput
            label="Room kind"
            value={roomForm.room_kind}
            onChange={(v) => setRoomForm({ ...roomForm, room_kind: v })}
            options={toEnumOptions(ROOM_KINDS)}
          />
          <TextInput
            label="Bed capacity"
            value={roomForm.bed_capacity}
            onChange={(v) => setRoomForm({ ...roomForm, bed_capacity: v })}
          />
          <TextInput
            label="Room floor"
            value={roomForm.floor}
            onChange={(v) => setRoomForm({ ...roomForm, floor: v })}
          />
          <SelectInput
            label="Room status"
            value={roomForm.status}
            onChange={(v) => setRoomForm({ ...roomForm, status: v })}
            options={toEnumOptions(ROOM_STATUSES)}
          />
        </FormDialog>
      )}
    </div>
  );
}
