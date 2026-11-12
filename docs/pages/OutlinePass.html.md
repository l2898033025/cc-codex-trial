*Inheritance: Pass →*

# OutlinePass

A pass for rendering outlines around selected objects.

## Code Example

```js
const resolution = new THREE.Vector2( window.innerWidth, window.innerHeight );
const outlinePass = new OutlinePass( resolution, scene, camera );
composer.addPass( outlinePass );
```

## Import

OutlinePass is an addon, and must be imported explicitly, see [Installation#Addons](https://threejs.org/manual/#installation#addons).

```js
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
```

## Constructor

### new OutlinePass( resolution : Vector2, scene : Scene, camera : Camera, selectedObjects : Array.<Object3D> )

Constructs a new outline pass.

**resolution**

The effect's resolution.

**scene**

The scene to render.

**camera**

The camera.

**selectedObjects**

The selected 3D objects that should receive an outline.

## Properties

### .downSampleRatio : number

The downsample ratio. The effect can be rendered in a much lower resolution than the beauty pass.

Default is `2`.

### .edgeGlow : number

Can be used for an animated glow/pulse effect.

Default is `0`.

### .edgeStrength : number

The edge strength.

Default is `3`.

### .edgeThickness : number

The edge thickness.

Default is `1`.

### .hiddenEdgeColor : Color

The hidden edge color.

Default is `(0.1,0.04,0.02)`.

### .patternTexture : Texture

Can be used to highlight selected 3D objects. Requires to set [OutlinePass#usePatternTexture](OutlinePass.html#usePatternTexture) to `true`.

Default is `null`.

### .pulsePeriod : number

The pulse period.

Default is `0`.

### .renderCamera : Object

The camera.

### .renderScene : Object

The scene to render.

### .resolution : Vector2

The effect's resolution.

Default is `(256,256)`.

### .selectedObjects : Array.<Object3D>

The selected 3D objects that should receive an outline.

### .selectedInstances : Map.<InstancedMesh, Set.<number>>

Per-instance selection for `InstancedMesh` objects. Keys are the selected instanced meshes, values are sets of selected instance IDs. Prefer [OutlinePass#setSelectedInstances](OutlinePass.html#setSelectedInstances) over writing this map directly. An instanced mesh that is also part of [OutlinePass#selectedObjects](OutlinePass.html#selectedObjects) is outlined as a whole, and its per-instance selection is ignored.

### .usePatternTexture : boolean

Whether to use a pattern texture for to highlight selected 3D objects or not.

Default is `false`.

### .visibleEdgeColor : Color

The visible edge color.

Default is `(1,1,1)`.

## Methods

### .dispose()

Frees the GPU-related resources allocated by this instance. Call this method whenever the pass is no longer used in your app.

**Overrides:** [Pass#dispose](Pass.html#dispose)

### .clearSelectedInstances()

Removes every per-instance selection. Whole-object selections in [OutlinePass#selectedObjects](OutlinePass.html#selectedObjects) are not affected.

### .setSelectedInstances( instancedMesh : InstancedMesh, instanceIds : Array.<number> )

Selects individual instances of an `InstancedMesh`. Out-of-range and non-integer IDs are ignored, so an invalid ID never outlines the whole batch. Passing an empty array clears the per-instance selection of the given mesh. If the same mesh is also contained in [OutlinePass#selectedObjects](OutlinePass.html#selectedObjects), the whole-object selection takes precedence.

**instancedMesh**

The instanced mesh that holds the selected instances.

**instanceIds**

The instance IDs returned, for example, by `Raycaster` intersections.

### .render( renderer : WebGLRenderer, writeBuffer : WebGLRenderTarget, readBuffer : WebGLRenderTarget, deltaTime : number, maskActive : boolean )

Performs the Outline pass.

**renderer**

The renderer.

**writeBuffer**

The write buffer. This buffer is intended as the rendering destination for the pass.

**readBuffer**

The read buffer. The pass can access the result from the previous pass from this buffer.

**deltaTime**

The delta time in seconds.

**maskActive**

Whether masking is active or not.

**Overrides:** [Pass#render](Pass.html#render)

### .setSize( width : number, height : number )

Sets the size of the pass.

**width**

The width to set.

**height**

The height to set.

**Overrides:** [Pass#setSize](Pass.html#setSize)

## Source

[examples/jsm/postprocessing/OutlinePass.js](https://github.com/mrdoob/three.js/blob/master/examples/jsm/postprocessing/OutlinePass.js)
