// task_complete — explicit completion signal for the agent loop.
//
// Relying only on "the model stopped calling tools" to detect completion
// misfires when a model narrates an action without performing it. This gives the
// model a clean way to declare it is finished, and a summary we can stitch into
// session_context.md.
export default {
  name: 'task_complete',
  description:
    'Call this ONLY when the task is fully implemented (and verified if applicable) to finish. Provide a short summary of what you changed.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'A short summary of the work done.' },
    },
    required: ['summary'],
  },
  async run(args) {
    return { ok: true, done: true, summary: String(args.summary ?? '') };
  },
};
