import type { NodeLike } from "./node-like.js";

const nodeStack: NodeLike[] = [];

export function getCurrentNode(): NodeLike | null {
  return nodeStack.length > 0 ? nodeStack[nodeStack.length - 1] : null;
}

export function getNode(): NodeLike {
  const current = getCurrentNode();
  if (!current) {
    throw new Error("No Fame node is currently bound to the context");
  }
  return current;
}

export function pushNode(node: NodeLike): () => void {
  nodeStack.push(node);
  let popped = false;
  return () => {
    if (popped) {
      return;
    }
    popped = true;
    const current = nodeStack[nodeStack.length - 1];
    if (current === node) {
      nodeStack.pop();
      return;
    }

    const index = nodeStack.lastIndexOf(node);
    if (index >= 0) {
      nodeStack.splice(index, 1);
    }
  };
}

export async function withNodeContextAsync<T>(node: NodeLike, fn: () => Promise<T>): Promise<T> {
  const pop = pushNode(node);
  try {
    return await fn();
  } finally {
    pop();
  }
}

export function runWithNodeContext<T>(node: NodeLike, fn: () => T): T {
  const pop = pushNode(node);
  try {
    return fn();
  } finally {
    pop();
  }
}
