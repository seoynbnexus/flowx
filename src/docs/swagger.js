import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';

const spec = YAML.load(new URL('../../docs/openapi.yaml', import.meta.url).pathname);

export default [swaggerUi.serve, swaggerUi.setup(spec, { explorer: true })];
