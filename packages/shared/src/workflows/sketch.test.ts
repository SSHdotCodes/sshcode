import { describe, expect, it } from "vite-plus/test";

import { WorkflowNodeId, type WorkflowMark } from "@t3tools/contracts";

import {
  markBox,
  markStrokePath,
  sketchBounds,
  sketchExampleWorkflow,
  sketchFitScale,
  sketchPreview,
  sketchPreviewNodes,
} from "./sketch.ts";

const card = { width: 230, height: 104 };

describe("sketchPreviewNodes", () => {
  it("redraws a drawing that would shrink to fuzz as compact boxes flowing sideways", () => {
    let n = 0;
    const workflow = sketchExampleWorkflow("2026-11-06T00:00:00.000Z", true, () => String(n++));
    const agents = workflow.nodes.filter((node) => node.kind === "agent");
    const compact = sketchPreviewNodes(agents, workflow.edges, card);
    expect(compact).not.toBe(agents);
    expect(sketchFitScale(compact, card)).toBeGreaterThan(sketchFitScale(agents, card) * 1.5);
    const lead = compact.find((node) => node.id === workflow.rootNodeId)!;
    // The lead starts the row; every other box sits to its right.
    expect(compact.every((node) => node.id === lead.id || node.x > lead.x)).toBe(true);
  });

  it("keeps a drawing that already fits as drawn", () => {
    let n = 0;
    const workflow = sketchExampleWorkflow("2026-11-06T00:00:00.000Z", true, () => String(n++));
    const agents = workflow.nodes.filter((node) => node.kind === "agent");
    expect(sketchPreviewNodes(agents, workflow.edges, { width: 1200, height: 900 })).toBe(agents);
  });
});

describe("sketchPreview", () => {
  const example = () => {
    let n = 0;
    const workflow = sketchExampleWorkflow("2026-11-06T00:00:00.000Z", true, () => String(n++));
    return { workflow, agents: workflow.nodes.filter((node) => node.kind === "agent") };
  };
  const circle: WorkflowMark = {
    kind: "stroke",
    id: WorkflowNodeId.make("m_circle"),
    x: 0,
    y: -40,
    points: [0, 0, 300, 0, 300, 200, 0, 200, 0, 0],
    color: "red",
    weight: "bold",
  };
  const label = (size: "s" | "xl"): WorkflowMark => ({
    kind: "text",
    id: WorkflowNodeId.make(`m_${size}`),
    x: 0,
    y: -120,
    text: "Release",
    color: "ink",
    size,
  });

  it("fits marks with the boxes when the drawing stays as drawn", () => {
    const { workflow, agents } = example();
    const lead = agents.filter((node) => node.id === workflow.rootNodeId);
    const area = { width: 600, height: 400 };
    const preview = sketchPreview(lead, [], [circle, label("xl")], area);
    expect(preview.nodes).toBe(lead);
    expect(preview.marks).toHaveLength(2);
    // The text above the box widens the drawing upward.
    expect(preview.viewBox.y).toBeLessThan(lead[0]!.y - 120);
    expect(preview.scale).toBeLessThan(sketchFitScale(lead, area));
  });

  it("moves a mark around one box with it when the boxes go compact, leaving out the rest", () => {
    const { workflow, agents } = example();
    const lead = agents.find((node) => node.id === workflow.rootNodeId)!;
    // A ring 30 units outside the lead, and a line across the whole team.
    const ring: WorkflowMark = {
      ...circle,
      id: WorkflowNodeId.make("m_ring"),
      x: lead.x - 30,
      y: lead.y - 30,
      points: [0, 0, lead.width + 60, 0, lead.width + 60, lead.height + 60, 0, lead.height + 60],
    };
    const across: WorkflowMark = {
      ...circle,
      id: WorkflowNodeId.make("m_across"),
      x: 0,
      y: 200,
      points: [0, 0, 900, 0],
    };
    const preview = sketchPreview(agents, workflow.edges, [ring, across], card);
    expect(preview.nodes).not.toBe(agents);
    expect(preview.marks.map((mark) => mark.id)).toEqual(["m_ring"]);
    const moved = preview.marks[0]!;
    const compactLead = preview.nodes.find((node) => node.id === lead.id)!;
    const scaleX = compactLead.width / lead.width;
    expect(moved.x).toBeCloseTo(compactLead.x - 30 * scaleX);
    expect(markBox(moved).width).toBeLessThan(markBox(ring).width);
  });

  it("leaves out text too small to read, keeping strokes", () => {
    const { workflow, agents } = example();
    const lead = agents.filter((node) => node.id === workflow.rootNodeId);
    const marks = [circle, label("s"), label("xl")];
    // Just above the size where boxes go compact: 20-unit text shows under 9.5px.
    const bounds = sketchBounds(lead, marks);
    const area = { width: bounds.width * 0.46, height: bounds.height * 0.46 };
    const preview = sketchPreview(lead, [], marks, area);
    expect(preview.nodes).toBe(lead);
    expect(preview.marks.map((mark) => mark.id)).toEqual(["m_circle", "m_xl"]);
  });

  it("draws a drawing of only marks", () => {
    const preview = sketchPreview([], [], [circle], card);
    expect(preview.marks).toEqual([circle]);
    expect(preview.viewBox.width).toBeGreaterThan(300);
  });
});

describe("mark geometry", () => {
  it("draws a stroke as curves through its midpoints, rounded", () => {
    expect(markStrokePath([0, 0, 10, 10, 20, 0])).toBe("M0 0Q10 10 15 5L20 0");
    expect(markStrokePath([1 / 3, 2])).toBe("M0.3 2l0.01 0");
  });

  it("boxes text marks by their longest line", () => {
    const text = {
      kind: "text",
      id: WorkflowNodeId.make("m_1"),
      x: 10,
      y: 20,
      text: "ab\nabcd",
      color: "ink",
      size: "s",
    } as const;
    expect(markBox(text)).toEqual({ x: 10, y: 20, width: 4 * 20 * 0.48 + 8, height: 2 * 24 + 4 });
  });
});
