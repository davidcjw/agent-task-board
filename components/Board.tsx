"use client";

import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { Status, Task } from "@/lib/types";
import { STATUSES } from "@/lib/columns";
import { Column } from "./Column";
import { TaskCardBody, type TaskCardCallbacks } from "./TaskCard";

interface BoardProps extends TaskCardCallbacks {
  /** Full ordered id-lists per column (drag math always references these). */
  columns: Record<Status, string[]>;
  tasksById: Record<string, Task>;
  /** Filtered, ordered tasks to render per column. */
  columnTasks: Record<Status, Task[]>;
  /** Archived tasks per column (revealed behind a toggle). */
  archivedTasks: Record<Status, Task[]>;
  now: number;
  filtering: boolean;
  onAdd: (status: Status) => void;
  onCommitDrag: (columns: Record<Status, string[]>, movedId: string, toStatus: Status) => void;
}

function isColumnId(id: string): id is Status {
  return (STATUSES as string[]).includes(id);
}

export function Board({
  columns,
  tasksById,
  columnTasks,
  archivedTasks,
  now,
  filtering,
  onAdd,
  onCommitDrag,
  ...callbacks
}: BoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const activeKey = String(active.id);
    const overKey = String(over.id);
    if (activeKey === overKey) return;

    const moved = tasksById[activeKey];
    if (!moved) return;
    const fromStatus = moved.status;
    const overIsColumn = isColumnId(overKey);
    const toStatus: Status | undefined = overIsColumn ? overKey : tasksById[overKey]?.status;
    if (!toStatus) return;

    const next: Record<Status, string[]> = {
      queued: [...columns.queued],
      running: [...columns.running],
      review: [...columns.review],
      done: [...columns.done],
    };

    if (fromStatus === toStatus) {
      const arr = next[fromStatus];
      const oldIndex = arr.indexOf(activeKey);
      const newIndex = overIsColumn ? arr.length - 1 : arr.indexOf(overKey);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      next[fromStatus] = arrayMove(arr, oldIndex, newIndex);
    } else {
      next[fromStatus] = next[fromStatus].filter((id) => id !== activeKey);
      const destIndex = overIsColumn ? next[toStatus].length : Math.max(0, next[toStatus].indexOf(overKey));
      next[toStatus].splice(destIndex, 0, activeKey);
    }

    onCommitDrag(next, activeKey, toStatus);
  }

  const activeTask = activeId ? tasksById[activeId] : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleStart}
      onDragEnd={handleEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="grid auto-cols-[300px] grid-flow-col gap-3 overflow-x-auto pb-4 md:grid-flow-row md:auto-cols-auto md:grid-cols-4 md:gap-4 md:overflow-visible">
        {STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            tasks={columnTasks[status]}
            archived={archivedTasks[status]}
            now={now}
            filtering={filtering}
            onAdd={onAdd}
            {...callbacks}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" }}>
        {activeTask ? (
          <div className="w-[290px] rotate-[0.6deg] cursor-grabbing">
            <TaskCardBody task={activeTask} now={now} overlay {...callbacks} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
