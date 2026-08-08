import 'dotenv/config';
import tracer from 'dd-trace';

if (/^(1|true)$/i.test(process.env['DD_LLMOBS_ENABLED'] ?? '')) {
  tracer.init();
}

export default tracer;
