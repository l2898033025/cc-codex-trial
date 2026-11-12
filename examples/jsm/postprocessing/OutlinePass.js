import {
	AdditiveBlending,
	Color,
	DataTexture,
	DoubleSide,
	HalfFloatType,
	Matrix4,
	MeshDepthMaterial,
	NearestFilter,
	NoBlending,
	RedFormat,
	RGBADepthPacking,
	ShaderMaterial,
	UniformsUtils,
	Vector2,
	Vector3,
	WebGLRenderTarget,
	UnsignedByteType
} from 'three';
import { Pass, FullScreenQuad } from './Pass.js';
import { CopyShader } from '../shaders/CopyShader.js';

/**
 * A pass for rendering outlines around selected objects.
 *
 * ```js
 * const resolution = new THREE.Vector2( window.innerWidth, window.innerHeight );
 * const outlinePass = new OutlinePass( resolution, scene, camera );
 * composer.addPass( outlinePass );
 * ```
 *
 * @augments Pass
 * @three_import import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
 */
class OutlinePass extends Pass {

	/**
	 * Constructs a new outline pass.
	 *
	 * @param {Vector2} [resolution] - The effect's resolution.
	 * @param {Scene} scene - The scene to render.
	 * @param {Camera} camera - The camera.
	 * @param {Array<Object3D>} [selectedObjects] - The selected 3D objects that should receive an outline.
	 *
	 */
	constructor( resolution, scene, camera, selectedObjects ) {

		super();

		/**
		 * The scene to render.
		 *
		 * @type {Object}
		 */
		this.renderScene = scene;

		/**
		 * The camera.
		 *
		 * @type {Object}
		 */
		this.renderCamera = camera;

		/**
		 * The selected 3D objects that should receive an outline.
		 *
		 * @type {Array<Object3D>}
		 */
		this.selectedObjects = selectedObjects !== undefined ? selectedObjects : [];

		/**
		 * Per-instance selection for `InstancedMesh` objects. The keys are the
		 * selected `InstancedMesh` objects, the values are `Set` instances holding
		 * the selected instance IDs. Use {@link OutlinePass#setSelectedInstances}
		 * to assign selections. An `InstancedMesh` that is also part of
		 * {@link OutlinePass#selectedObjects} is outlined as a whole and per-instance
		 * selection for that mesh is ignored.
		 *
		 * @type {Map<InstancedMesh, Set<number>>}
		 */
		this.selectedInstances = new Map();

		/**
		 * The visible edge color.
		 *
		 * @type {Color}
		 * @default (1,1,1)
		 */
		this.visibleEdgeColor = new Color( 1, 1, 1 );

		/**
		 * The hidden edge color.
		 *
		 * @type {Color}
		 * @default (0.1,0.04,0.02)
		 */
		this.hiddenEdgeColor = new Color( 0.1, 0.04, 0.02 );

		/**
		 * Can be used for an animated glow/pulse effect.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.edgeGlow = 0.0;

		/**
		 * Whether to use a pattern texture for to highlight selected
		 * 3D objects or not.
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.usePatternTexture = false;

		/**
		 * Can be used to highlight selected 3D objects. Requires to set
		 * {@link OutlinePass#usePatternTexture} to `true`.
		 *
		 * @type {?Texture}
		 * @default null
		 */
		this.patternTexture = null;

		/**
		 * The edge thickness.
		 *
		 * @type {number}
		 * @default 1
		 */
		this.edgeThickness = 1.0;

		/**
		 * The edge strength.
		 *
		 * @type {number}
		 * @default 3
		 */
		this.edgeStrength = 3.0;

		/**
		 * The downsample ratio. The effect can be rendered in a much
		 * lower resolution than the beauty pass.
		 *
		 * @type {number}
		 * @default 2
		 */
		this.downSampleRatio = 2;

		/**
		 * The pulse period.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.pulsePeriod = 0;

		this._visibilityCache = new Map();
		this._selectionCache = new Set();
		this._instanceSelectionCache = new Map();
		this._instanceFilterCallback = null;
		this._instanceFilterMeshes = [];

		/**
		 * The effect's resolution.
		 *
		 * @type {Vector2}
		 * @default (256,256)
		 */
		this.resolution = ( resolution !== undefined ) ? new Vector2( resolution.x, resolution.y ) : new Vector2( 256, 256 );

		const resx = Math.round( this.resolution.x / this.downSampleRatio );
		const resy = Math.round( this.resolution.y / this.downSampleRatio );

		this.renderTargetMaskBuffer = new WebGLRenderTarget( this.resolution.x, this.resolution.y );
		this.renderTargetMaskBuffer.texture.name = 'OutlinePass.mask';
		this.renderTargetMaskBuffer.texture.generateMipmaps = false;

		this.depthMaterial = new MeshDepthMaterial();
		this.depthMaterial.side = DoubleSide;
		this.depthMaterial.depthPacking = RGBADepthPacking;
		this.depthMaterial.blending = NoBlending;
		this._setupInstanceFilter( this.depthMaterial, true );

		this.prepareMaskMaterial = this._getPrepareMaskMaterial();
		this.prepareMaskMaterial.side = DoubleSide;
		this.prepareMaskMaterial.fragmentShader = replaceDepthToViewZ( this.prepareMaskMaterial.fragmentShader, this.renderCamera );

		this.renderTargetDepthBuffer = new WebGLRenderTarget( this.resolution.x, this.resolution.y, { type: HalfFloatType } );
		this.renderTargetDepthBuffer.texture.name = 'OutlinePass.depth';
		this.renderTargetDepthBuffer.texture.generateMipmaps = false;

		this.renderTargetMaskDownSampleBuffer = new WebGLRenderTarget( resx, resy, { type: HalfFloatType, depthBuffer: false } );
		this.renderTargetMaskDownSampleBuffer.texture.name = 'OutlinePass.depthDownSample';
		this.renderTargetMaskDownSampleBuffer.texture.generateMipmaps = false;

		this.renderTargetBlurBuffer1 = new WebGLRenderTarget( resx, resy, { type: HalfFloatType, depthBuffer: false } );
		this.renderTargetBlurBuffer1.texture.name = 'OutlinePass.blur1';
		this.renderTargetBlurBuffer1.texture.generateMipmaps = false;
		this.renderTargetBlurBuffer2 = new WebGLRenderTarget( Math.round( resx / 2 ), Math.round( resy / 2 ), { type: HalfFloatType, depthBuffer: false } );
		this.renderTargetBlurBuffer2.texture.name = 'OutlinePass.blur2';
		this.renderTargetBlurBuffer2.texture.generateMipmaps = false;

		this.edgeDetectionMaterial = this._getEdgeDetectionMaterial();
		this.renderTargetEdgeBuffer1 = new WebGLRenderTarget( resx, resy, { type: HalfFloatType, depthBuffer: false } );
		this.renderTargetEdgeBuffer1.texture.name = 'OutlinePass.edge1';
		this.renderTargetEdgeBuffer1.texture.generateMipmaps = false;
		this.renderTargetEdgeBuffer2 = new WebGLRenderTarget( Math.round( resx / 2 ), Math.round( resy / 2 ), { type: HalfFloatType, depthBuffer: false } );
		this.renderTargetEdgeBuffer2.texture.name = 'OutlinePass.edge2';
		this.renderTargetEdgeBuffer2.texture.generateMipmaps = false;

		const MAX_EDGE_THICKNESS = 4;
		const MAX_EDGE_GLOW = 4;

		this.separableBlurMaterial1 = this._getSeparableBlurMaterial( MAX_EDGE_THICKNESS );
		this.separableBlurMaterial1.uniforms[ 'texSize' ].value.set( resx, resy );
		this.separableBlurMaterial1.uniforms[ 'kernelRadius' ].value = 1;
		this.separableBlurMaterial2 = this._getSeparableBlurMaterial( MAX_EDGE_GLOW );
		this.separableBlurMaterial2.uniforms[ 'texSize' ].value.set( Math.round( resx / 2 ), Math.round( resy / 2 ) );
		this.separableBlurMaterial2.uniforms[ 'kernelRadius' ].value = MAX_EDGE_GLOW;

		// Overlay material
		this.overlayMaterial = this._getOverlayMaterial();

		// copy material

		const copyShader = CopyShader;

		this.copyUniforms = UniformsUtils.clone( copyShader.uniforms );

		this.materialCopy = new ShaderMaterial( {
			uniforms: this.copyUniforms,
			vertexShader: copyShader.vertexShader,
			fragmentShader: copyShader.fragmentShader,
			blending: NoBlending,
			depthTest: false,
			depthWrite: false
		} );

		this.enabled = true;
		this.needsSwap = false;

		this._oldClearColor = new Color();
		this.oldClearAlpha = 1;

		this._fsQuad = new FullScreenQuad( null );

		this.tempPulseColor1 = new Color();
		this.tempPulseColor2 = new Color();
		this.textureMatrix = new Matrix4();

		function replaceDepthToViewZ( string, camera ) {

			const type = camera.isPerspectiveCamera ? 'perspective' : 'orthographic';

			return string.replace( /DEPTH_TO_VIEW_Z/g, type + 'DepthToViewZ' );

		}

	}

	/**
	 * Frees the GPU-related resources allocated by this instance. Call this
	 * method whenever the pass is no longer used in your app.
	 */
	dispose() {

		this.renderTargetMaskBuffer.dispose();
		this.renderTargetDepthBuffer.dispose();
		this.renderTargetMaskDownSampleBuffer.dispose();
		this.renderTargetBlurBuffer1.dispose();
		this.renderTargetBlurBuffer2.dispose();
		this.renderTargetEdgeBuffer1.dispose();
		this.renderTargetEdgeBuffer2.dispose();

		this.depthMaterial.dispose();
		this.prepareMaskMaterial.dispose();
		this.edgeDetectionMaterial.dispose();
		this.separableBlurMaterial1.dispose();
		this.separableBlurMaterial2.dispose();
		this.overlayMaterial.dispose();
		this.materialCopy.dispose();

		this._fsQuad.dispose();

		for ( const texture of this._instanceSelectionCache.values() ) texture.dispose();
		this._instanceSelectionCache.clear();
		this.selectedInstances.clear();

	}

	/**
	 * Sets the size of the pass.
	 *
	 * @param {number} width - The width to set.
	 * @param {number} height - The height to set.
	 */
	setSize( width, height ) {

		this.renderTargetMaskBuffer.setSize( width, height );
		this.renderTargetDepthBuffer.setSize( width, height );

		let resx = Math.round( width / this.downSampleRatio );
		let resy = Math.round( height / this.downSampleRatio );
		this.renderTargetMaskDownSampleBuffer.setSize( resx, resy );
		this.renderTargetBlurBuffer1.setSize( resx, resy );
		this.renderTargetEdgeBuffer1.setSize( resx, resy );
		this.separableBlurMaterial1.uniforms[ 'texSize' ].value.set( resx, resy );

		resx = Math.round( resx / 2 );
		resy = Math.round( resy / 2 );

		this.renderTargetBlurBuffer2.setSize( resx, resy );
		this.renderTargetEdgeBuffer2.setSize( resx, resy );

		this.separableBlurMaterial2.uniforms[ 'texSize' ].value.set( resx, resy );

	}

	/**
	 * Performs the Outline pass.
	 *
	 * @param {WebGLRenderer} renderer - The renderer.
	 * @param {WebGLRenderTarget} writeBuffer - The write buffer. This buffer is intended as the rendering
	 * destination for the pass.
	 * @param {WebGLRenderTarget} readBuffer - The read buffer. The pass can access the result from the
	 * previous pass from this buffer.
	 * @param {number} deltaTime - The delta time in seconds.
	 * @param {boolean} maskActive - Whether masking is active or not.
	 */
	render( renderer, writeBuffer, readBuffer, deltaTime, maskActive ) {

		const hasSelection = this.selectedObjects.length > 0 || this._hasInstanceSelection();

		if ( hasSelection ) {

			renderer.getClearColor( this._oldClearColor );
			this.oldClearAlpha = renderer.getClearAlpha();
			const oldAutoClear = renderer.autoClear;

			renderer.autoClear = false;

			if ( maskActive ) renderer.state.buffers.stencil.setTest( false );

			renderer.setClearColor( 0xffffff, 1 );

			this._updateSelectionCache();

			const currentBackground = this.renderScene.background;
			const currentOverrideMaterial = this.renderScene.overrideMaterial;
			this.renderScene.background = null;

			// Update Texture Matrix for Depth compare
			this._updateTextureMatrix();

			try {

				this._updateInstanceSelectionTextures();

				try {

					// 1. Depth pass. Fully selected objects are hidden entirely. Partially
					// selected InstancedMesh objects are hidden for the main scene draw and
					// then rendered separately with the unselected instances only, so both
					// regular occluders and non-selected instances of the same batch write
					// into the depth buffer.
					this._setSceneVisibility( 'depth-main' );
					this.renderScene.overrideMaterial = this.depthMaterial;
					renderer.setRenderTarget( this.renderTargetDepthBuffer );
					renderer.clear();
					renderer.render( this.renderScene, this.renderCamera );

					if ( this._instanceFilterMeshes.length > 0 ) {

						this._setSceneVisibility( 'depth-instances' );
						this._bindInstanceFilter( this.depthMaterial );
						renderer.clearDepth();
						renderer.render( this.renderScene, this.renderCamera );

					}

					// 2. Mask pass. Render only the selected geometry and compare it against
					// the depth buffer of everything that can occlude it.
					this._setSceneVisibility( 'mask-main' );
					this.renderScene.overrideMaterial = this.prepareMaskMaterial;
					this.prepareMaskMaterial.uniforms[ 'cameraNearFar' ].value.set( this.renderCamera.near, this.renderCamera.far );
					this.prepareMaskMaterial.uniforms[ 'depthTexture' ].value = this.renderTargetDepthBuffer.texture;
					this.prepareMaskMaterial.uniforms[ 'textureMatrix' ].value = this.textureMatrix;
					renderer.setRenderTarget( this.renderTargetMaskBuffer );
					renderer.clear();
					renderer.render( this.renderScene, this.renderCamera );

					if ( this._instanceFilterMeshes.length > 0 ) {

						this._setSceneVisibility( 'mask-instances' );
						this._bindInstanceFilter( this.prepareMaskMaterial );
						renderer.clearDepth();
						renderer.render( this.renderScene, this.renderCamera );

					}

				} finally {

					this._unbindInstanceFilter( this.depthMaterial );
					this._unbindInstanceFilter( this.prepareMaskMaterial );
					this._restoreSceneVisibility();
					this._visibilityCache.clear();
					this._selectionCache.clear();
					this._instanceFilterMeshes.length = 0;
					this.renderScene.background = currentBackground;
					this.renderScene.overrideMaterial = currentOverrideMaterial;

				}

				// 2. Downsample to Half resolution
				this._fsQuad.material = this.materialCopy;
				this.copyUniforms[ 'tDiffuse' ].value = this.renderTargetMaskBuffer.texture;
				renderer.setRenderTarget( this.renderTargetMaskDownSampleBuffer );
				renderer.clear();
				this._fsQuad.render( renderer );

				this.tempPulseColor1.copy( this.visibleEdgeColor );
				this.tempPulseColor2.copy( this.hiddenEdgeColor );

				if ( this.pulsePeriod > 0 ) {

					const scalar = ( 1 + 0.25 ) / 2 + Math.cos( performance.now() * 0.01 / this.pulsePeriod ) * ( 1.0 - 0.25 ) / 2;
					this.tempPulseColor1.multiplyScalar( scalar );
					this.tempPulseColor2.multiplyScalar( scalar );

				}

				// 3. Apply Edge Detection Pass
				this._fsQuad.material = this.edgeDetectionMaterial;
				this.edgeDetectionMaterial.uniforms[ 'maskTexture' ].value = this.renderTargetMaskDownSampleBuffer.texture;
				this.edgeDetectionMaterial.uniforms[ 'texSize' ].value.set( this.renderTargetMaskDownSampleBuffer.width, this.renderTargetMaskDownSampleBuffer.height );
				this.edgeDetectionMaterial.uniforms[ 'visibleEdgeColor' ].value = this.tempPulseColor1;
				this.edgeDetectionMaterial.uniforms[ 'hiddenEdgeColor' ].value = this.tempPulseColor2;
				renderer.setRenderTarget( this.renderTargetEdgeBuffer1 );
				renderer.clear();
				this._fsQuad.render( renderer );

				// 4. Apply Blur on Half res
				this._fsQuad.material = this.separableBlurMaterial1;
				this.separableBlurMaterial1.uniforms[ 'colorTexture' ].value = this.renderTargetEdgeBuffer1.texture;
				this.separableBlurMaterial1.uniforms[ 'direction' ].value = OutlinePass.BlurDirectionX;
				this.separableBlurMaterial1.uniforms[ 'kernelRadius' ].value = this.edgeThickness;
				renderer.setRenderTarget( this.renderTargetBlurBuffer1 );
				renderer.clear();
				this._fsQuad.render( renderer );
				this.separableBlurMaterial1.uniforms[ 'colorTexture' ].value = this.renderTargetBlurBuffer1.texture;
				this.separableBlurMaterial1.uniforms[ 'direction' ].value = OutlinePass.BlurDirectionY;
				renderer.setRenderTarget( this.renderTargetEdgeBuffer1 );
				renderer.clear();
				this._fsQuad.render( renderer );

				// Apply Blur on quarter res
				this._fsQuad.material = this.separableBlurMaterial2;
				this.separableBlurMaterial2.uniforms[ 'colorTexture' ].value = this.renderTargetEdgeBuffer1.texture;
				this.separableBlurMaterial2.uniforms[ 'direction' ].value = OutlinePass.BlurDirectionX;
				renderer.setRenderTarget( this.renderTargetBlurBuffer2 );
				renderer.clear();
				this._fsQuad.render( renderer );
				this.separableBlurMaterial2.uniforms[ 'colorTexture' ].value = this.renderTargetBlurBuffer2.texture;
				this.separableBlurMaterial2.uniforms[ 'direction' ].value = OutlinePass.BlurDirectionY;
				renderer.setRenderTarget( this.renderTargetEdgeBuffer2 );
				renderer.clear();
				this._fsQuad.render( renderer );

				// Blend it additively over the input texture
				this._fsQuad.material = this.overlayMaterial;
				this.overlayMaterial.uniforms[ 'maskTexture' ].value = this.renderTargetMaskBuffer.texture;
				this.overlayMaterial.uniforms[ 'edgeTexture1' ].value = this.renderTargetEdgeBuffer1.texture;
				this.overlayMaterial.uniforms[ 'edgeTexture2' ].value = this.renderTargetEdgeBuffer2.texture;
				this.overlayMaterial.uniforms[ 'patternTexture' ].value = this.patternTexture;
				this.overlayMaterial.uniforms[ 'edgeStrength' ].value = this.edgeStrength;
				this.overlayMaterial.uniforms[ 'edgeGlow' ].value = this.edgeGlow;
				this.overlayMaterial.uniforms[ 'usePatternTexture' ].value = this.usePatternTexture;


				if ( maskActive ) renderer.state.buffers.stencil.setTest( true );

				renderer.setRenderTarget( readBuffer );
				this._fsQuad.render( renderer );

			} finally {

				renderer.setClearColor( this._oldClearColor, this.oldClearAlpha );
				renderer.autoClear = oldAutoClear;

				if ( maskActive ) renderer.state.buffers.stencil.setTest( true );

			}

		}

		if ( this.renderToScreen ) {

			this._fsQuad.material = this.materialCopy;
			this.copyUniforms[ 'tDiffuse' ].value = readBuffer.texture;
			renderer.setRenderTarget( null );
			this._fsQuad.render( renderer );

		}

	}

	// internals

	_updateSelectionCache() {

		const cache = this._selectionCache;

		function gatherSelectedMeshesCallBack( object ) {

			if ( object.isMesh ) cache.add( object );

		}

		cache.clear();
		this._instanceFilterMeshes.length = 0;

		for ( let i = 0; i < this.selectedObjects.length; i ++ ) {

			const selectedObject = this.selectedObjects[ i ];
			selectedObject.traverse( gatherSelectedMeshesCallBack );

		}

	}

	_hasInstanceSelection() {

		for ( const ids of this.selectedInstances.values() ) {

			if ( ids.size > 0 ) return true;

		}

		return false;

	}

	/**
	 * Selects individual instances of an `InstancedMesh`. Out-of-range and
	 * non-integer IDs are ignored. Pass an empty array (or no IDs) to clear the
	 * per-instance selection of the given mesh. If the mesh is also part of
	 * {@link OutlinePass#selectedObjects}, the whole-object selection takes
	 * precedence and every instance is outlined.
	 *
	 * @param {InstancedMesh} instancedMesh - The instanced mesh to select from.
	 * @param {Array<number>} instanceIds - The selected instance IDs.
	 */
	setSelectedInstances( instancedMesh, instanceIds ) {

		if ( instancedMesh === null || instancedMesh === undefined || ! instancedMesh.isInstancedMesh ) {

			throw new Error( 'OutlinePass: setSelectedInstances expects an InstancedMesh.' );

		}

		const ids = new Set();
		const count = instancedMesh.count;

		if ( instanceIds !== undefined && instanceIds !== null ) {

			for ( const id of instanceIds ) {

				if ( Number.isInteger( id ) && id >= 0 && id < count ) ids.add( id );

			}

		}

		if ( ids.size === 0 ) {

			this.selectedInstances.delete( instancedMesh );

		} else {

			this.selectedInstances.set( instancedMesh, ids );

		}

	}

	/**
	 * Clears all per-instance selections. Whole-object selections in
	 * {@link OutlinePass#selectedObjects} are not affected.
	 */
	clearSelectedInstances() {

		this.selectedInstances.clear();

	}

	_updateInstanceSelectionTextures() {

		const cache = this._instanceSelectionCache;
		const filterMeshes = this._instanceFilterMeshes;

		filterMeshes.length = 0;

		for ( const [ mesh, ids ] of this.selectedInstances ) {

			if ( ! mesh.isInstancedMesh || this._selectionCache.has( mesh ) ) continue;

			const validIds = new Set();

			for ( const id of ids ) {

				if ( Number.isInteger( id ) && id >= 0 && id < mesh.count ) validIds.add( id );

			}

			if ( validIds.size === 0 ) continue;

			const data = new Uint8Array( mesh.count );

			for ( const id of validIds ) data[ id ] = 1;

			let texture = cache.get( mesh );

			if ( texture === undefined ) {

				texture = new DataTexture( data, mesh.count, 1, RedFormat, UnsignedByteType );
				texture.minFilter = NearestFilter;
				texture.magFilter = NearestFilter;
				texture.generateMipmaps = false;
				texture.needsUpdate = true;
				cache.set( mesh, texture );

			} else {

				if ( texture.image.data.length !== data.length ) {

					texture.image.data = data;
					texture.image.width = mesh.count;
					texture.needsUpdate = true;

				} else {

					texture.image.data.set( data );

				}

				texture.needsUpdate = true;

			}

			filterMeshes.push( mesh );

		}

	}

	_setupInstanceFilter( material, useOnBeforeCompile ) {

		const uniforms = {
			useInstanceFilter: { value: 0 },
			instanceSelectionMap: { value: null }
		};

		const filterExpression = 'texture2D( instanceSelectionMap, vec2( ( vOutlineInstanceId + 0.5 ) / float( textureSize( instanceSelectionMap, 0 ).x ), 0.5 ) ).r';
		const vertexChunk = '#ifdef USE_INSTANCING\n\tvarying float vOutlineInstanceId;\n#endif\n';
		const vertexMainChunk = '#ifdef USE_INSTANCING\n\tvOutlineInstanceId = float( gl_InstanceID );\n#endif\n';
		const fragmentChunk = '#ifdef USE_INSTANCING\n\tvarying float vOutlineInstanceId;\n\tuniform bool useInstanceFilter;\n\tuniform sampler2D instanceSelectionMap;\n#endif\n';
		const fragmentMainChunk = '#ifdef USE_INSTANCING\n\tif ( useInstanceFilter ) {\n\t\tfloat selected = ' + filterExpression + ';\n\t\tif ( selected < 0.5 ) discard;\n\t}\n#endif\n';

		if ( useOnBeforeCompile ) {

			material.onBeforeCompile = ( shader ) => {

				shader.uniforms.useInstanceFilter = uniforms.useInstanceFilter;
				shader.uniforms.instanceSelectionMap = uniforms.instanceSelectionMap;

				shader.vertexShader = shader.vertexShader
					.replace( '#include <common>', '#include <common>\n' + vertexChunk )
					.replace( '#include <project_vertex>', vertexMainChunk + '\t#include <project_vertex>' );

				shader.fragmentShader = shader.fragmentShader
					.replace( '#include <common>', '#include <common>\n' + fragmentChunk )
					.replace( 'void main() {', 'void main() {\n' + fragmentMainChunk );

			};

			material.customProgramCacheKey = () => 'OutlinePassInstanceFilter';

		} else {

			material.uniforms.useInstanceFilter = uniforms.useInstanceFilter;
			material.uniforms.instanceSelectionMap = uniforms.instanceSelectionMap;

		}

		material._instanceFilterUniforms = uniforms;

	}

	_bindInstanceFilter( material ) {

		const uniforms = material._instanceFilterUniforms;
		const cache = this._instanceSelectionCache;

		uniforms.useInstanceFilter.value = 1;

		this._instanceFilterCallback = ( renderer, scene, camera, geometry, instanceMesh ) => {

			uniforms.instanceSelectionMap.value = cache.get( instanceMesh ) || null;

		};

		for ( const mesh of this._instanceFilterMeshes ) {

			mesh._outlinePassOnBeforeRender = mesh.onBeforeRender;
			mesh.onBeforeRender = this._instanceFilterCallback;

		}

	}

	_unbindInstanceFilter( material ) {

		for ( const mesh of this._instanceFilterMeshes ) {

			mesh.onBeforeRender = mesh._outlinePassOnBeforeRender;
			delete mesh._outlinePassOnBeforeRender;

		}

		material._instanceFilterUniforms.useInstanceFilter.value = 0;
		material._instanceFilterUniforms.instanceSelectionMap.value = null;
		this._instanceFilterCallback = null;

	}

	_setSceneVisibility( mode ) {

		const visibilityCache = this._visibilityCache;
		const selectionCache = this._selectionCache;
		const instanceSet = new Set( this._instanceFilterMeshes );

		function cacheVisibility( object ) {

			if ( ! visibilityCache.has( object ) ) visibilityCache.set( object, object.visible );

		}

		function applyVisibility( object ) {

			cacheVisibility( object );

			const isSelectedMesh = selectionCache.has( object );
			const isPartialInstance = instanceSet.has( object );

			if ( object.isPoints || object.isLine || object.isLine2 ) {

				// the visibility of points and lines is always set to false in order to
				// not affect the outline computation
				object.visible = false;

			} else if ( object.isMesh || object.isSprite ) {

				switch ( mode ) {

					case 'depth-main':
						object.visible = ! isSelectedMesh && ! isPartialInstance;
						break;

					case 'depth-instances':
						object.visible = isPartialInstance;
						break;

					case 'mask-main':
						object.visible = isSelectedMesh && ! isPartialInstance;
						break;

					case 'mask-instances':
						object.visible = isPartialInstance;
						break;

				}

			}

		}

		this.renderScene.traverse( applyVisibility );

	}

	_restoreSceneVisibility() {

		for ( const [ object, visible ] of this._visibilityCache ) object.visible = visible;

	}

	_updateTextureMatrix() {

		this.textureMatrix.set( 0.5, 0.0, 0.0, 0.5,
			0.0, 0.5, 0.0, 0.5,
			0.0, 0.0, 0.5, 0.5,
			0.0, 0.0, 0.0, 1.0 );
		this.textureMatrix.multiply( this.renderCamera.projectionMatrix );
		this.textureMatrix.multiply( this.renderCamera.matrixWorldInverse );

	}

	_getPrepareMaskMaterial() {

		const material = new ShaderMaterial( {

			uniforms: {
				'depthTexture': { value: null },
				'cameraNearFar': { value: new Vector2( 0.5, 0.5 ) },
				'textureMatrix': { value: null },
				'useInstanceFilter': { value: 0 },
				'instanceSelectionMap': { value: null }
			},

			vertexShader:
				`#include <batching_pars_vertex>
				#include <morphtarget_pars_vertex>
				#include <skinning_pars_vertex>

				#ifdef USE_INSTANCING
					varying float vOutlineInstanceId;
				#endif

				varying vec4 projTexCoord;
				varying vec4 vPosition;
				uniform mat4 textureMatrix;

				void main() {

					#include <batching_vertex>
					#include <skinbase_vertex>
					#include <begin_vertex>
					#include <morphtarget_vertex>
					#include <skinning_vertex>

					#ifdef USE_INSTANCING
						vOutlineInstanceId = float( gl_InstanceID );
					#endif

					#include <project_vertex>

					vPosition = mvPosition;

					vec4 worldPosition = vec4( transformed, 1.0 );

					#ifdef USE_INSTANCING

						worldPosition = instanceMatrix * worldPosition;

					#endif

					worldPosition = modelMatrix * worldPosition;

					projTexCoord = textureMatrix * worldPosition;

				}`,

			fragmentShader:
				`#include <packing>
				#ifdef USE_INSTANCING
					varying float vOutlineInstanceId;
					uniform bool useInstanceFilter;
					uniform sampler2D instanceSelectionMap;
				#endif
				varying vec4 vPosition;
				varying vec4 projTexCoord;
				uniform sampler2D depthTexture;
				uniform vec2 cameraNearFar;

				void main() {

					#ifdef USE_INSTANCING
						if ( useInstanceFilter ) {
							float selected = texture2D( instanceSelectionMap, vec2( ( vOutlineInstanceId + 0.5 ) / float( textureSize( instanceSelectionMap, 0 ).x ), 0.5 ) ).r;
							if ( selected < 0.5 ) discard;
						}
					#endif

					float depth = unpackRGBAToDepth(texture2DProj( depthTexture, projTexCoord ));
					float viewZ = - DEPTH_TO_VIEW_Z( depth, cameraNearFar.x, cameraNearFar.y );
					float depthTest = (-vPosition.z > viewZ) ? 1.0 : 0.0;
					gl_FragColor = vec4(0.0, depthTest, 1.0, 1.0);

				}`

		} );

		this._setupInstanceFilter( material, false );

		return material;

	}

	_getEdgeDetectionMaterial() {

		return new ShaderMaterial( {

			uniforms: {
				'maskTexture': { value: null },
				'texSize': { value: new Vector2( 0.5, 0.5 ) },
				'visibleEdgeColor': { value: new Vector3( 1.0, 1.0, 1.0 ) },
				'hiddenEdgeColor': { value: new Vector3( 1.0, 1.0, 1.0 ) },
			},

			vertexShader:
				`varying vec2 vUv;

				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,

			fragmentShader:
				`varying vec2 vUv;

				uniform sampler2D maskTexture;
				uniform vec2 texSize;
				uniform vec3 visibleEdgeColor;
				uniform vec3 hiddenEdgeColor;

				void main() {
					vec2 invSize = 1.0 / texSize;
					vec4 uvOffset = vec4(1.0, 0.0, 0.0, 1.0) * vec4(invSize, invSize);
					vec4 c1 = texture2D( maskTexture, vUv + uvOffset.xy);
					vec4 c2 = texture2D( maskTexture, vUv - uvOffset.xy);
					vec4 c3 = texture2D( maskTexture, vUv + uvOffset.yw);
					vec4 c4 = texture2D( maskTexture, vUv - uvOffset.yw);
					float diff1 = (c1.r - c2.r)*0.5;
					float diff2 = (c3.r - c4.r)*0.5;
					float d = length( vec2(diff1, diff2) );
					float a1 = min(c1.g, c2.g);
					float a2 = min(c3.g, c4.g);
					float visibilityFactor = min(a1, a2);
					vec3 edgeColor = 1.0 - visibilityFactor > 0.001 ? visibleEdgeColor : hiddenEdgeColor;
					gl_FragColor = vec4(edgeColor, 1.0) * vec4(d);
				}`
		} );

	}

	_getSeparableBlurMaterial( maxRadius ) {

		return new ShaderMaterial( {

			defines: {
				'MAX_RADIUS': maxRadius,
			},

			uniforms: {
				'colorTexture': { value: null },
				'texSize': { value: new Vector2( 0.5, 0.5 ) },
				'direction': { value: new Vector2( 0.5, 0.5 ) },
				'kernelRadius': { value: 1.0 }
			},

			vertexShader:
				`varying vec2 vUv;

				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,

			fragmentShader:
				`#include <common>
				varying vec2 vUv;
				uniform sampler2D colorTexture;
				uniform vec2 texSize;
				uniform vec2 direction;
				uniform float kernelRadius;

				float gaussianPdf(in float x, in float sigma) {
					return 0.39894 * exp( -0.5 * x * x/( sigma * sigma))/sigma;
				}

				void main() {
					vec2 invSize = 1.0 / texSize;
					float sigma = kernelRadius/2.0;
					float weightSum = gaussianPdf(0.0, sigma);
					vec4 diffuseSum = texture2D( colorTexture, vUv) * weightSum;
					vec2 delta = direction * invSize * kernelRadius/float(MAX_RADIUS);
					vec2 uvOffset = delta;
					for( int i = 1; i <= MAX_RADIUS; i ++ ) {
						float x = kernelRadius * float(i) / float(MAX_RADIUS);
						float w = gaussianPdf(x, sigma);
						vec4 sample1 = texture2D( colorTexture, vUv + uvOffset);
						vec4 sample2 = texture2D( colorTexture, vUv - uvOffset);
						diffuseSum += ((sample1 + sample2) * w);
						weightSum += (2.0 * w);
						uvOffset += delta;
					}
					gl_FragColor = diffuseSum/weightSum;
				}`
		} );

	}

	_getOverlayMaterial() {

		return new ShaderMaterial( {

			uniforms: {
				'maskTexture': { value: null },
				'edgeTexture1': { value: null },
				'edgeTexture2': { value: null },
				'patternTexture': { value: null },
				'edgeStrength': { value: 1.0 },
				'edgeGlow': { value: 1.0 },
				'usePatternTexture': { value: 0.0 }
			},

			vertexShader:
				`varying vec2 vUv;

				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,

			fragmentShader:
				`varying vec2 vUv;

				uniform sampler2D maskTexture;
				uniform sampler2D edgeTexture1;
				uniform sampler2D edgeTexture2;
				uniform sampler2D patternTexture;
				uniform float edgeStrength;
				uniform float edgeGlow;
				uniform bool usePatternTexture;

				void main() {
					vec4 edgeValue1 = texture2D(edgeTexture1, vUv);
					vec4 edgeValue2 = texture2D(edgeTexture2, vUv);
					vec4 maskColor = texture2D(maskTexture, vUv);
					vec4 patternColor = texture2D(patternTexture, 6.0 * vUv);
					float visibilityFactor = 1.0 - maskColor.g > 0.0 ? 1.0 : 0.5;
					vec4 edgeValue = edgeValue1 + edgeValue2 * edgeGlow;
					vec4 finalColor = edgeStrength * maskColor.r * edgeValue;
					if(usePatternTexture)
						finalColor += + visibilityFactor * (1.0 - maskColor.r) * (1.0 - patternColor.r);
					gl_FragColor = finalColor;
				}`,
			blending: AdditiveBlending,
			depthTest: false,
			depthWrite: false,
			transparent: true
		} );

	}

}

OutlinePass.BlurDirectionX = new Vector2( 1.0, 0.0 );
OutlinePass.BlurDirectionY = new Vector2( 0.0, 1.0 );

export { OutlinePass };
