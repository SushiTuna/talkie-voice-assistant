// Everything the tour needs from Babylon, behind one lazy import (main.js → loadBabylon()), so the
// bundler (server.mjs) emits it as a single chunk that downloads only when the tour is near.
import { MeshoptCompression } from "@babylonjs/core/Meshes/Compression/meshoptCompression.js";
import "@babylonjs/core/Collisions/collisionCoordinator.js"; // side effect: camera collisions
import "@babylonjs/loaders/glTF/index.js";
import "@babylonjs/loaders/OBJ/index.js";
import "@babylonjs/loaders/FBX/index.js";

// The GLBs are meshopt-compressed (tools/optimize-models.mjs). Babylon fetches the decoder from its
// CDN by default; serve our own copy instead so the tour has no third-party runtime dependency.
MeshoptCompression.Configuration.decoder.url = "/vendor/meshopt_decoder.js";

export { Engine } from "@babylonjs/core/Engines/engine.js";
export { Scene } from "@babylonjs/core/scene.js";
export { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
export { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
export { Ray } from "@babylonjs/core/Culling/ray.js";
export { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
export { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
export { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
export { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
export { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader.js";
export { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.js";
export { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
export { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
export { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
export { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
export { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js";
export { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline.js";
export { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
export { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration.js";
export { buildForest, addBroadleafTrees, makeGrassMaterial, addGroundOcclusion } from "./perimeter.js";
export * as mood from "./mood.js";
