import {
	BoxGeometry,
	Color,
	Group,
	InstancedMesh,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	PerspectiveCamera,
	Scene,
	Vector2,
	WebGLRenderer
} from 'three';
import { EffectComposer } from '../../../../examples/jsm/postprocessing/EffectComposer.js';
import { OutlinePass } from '../../../../examples/jsm/postprocessing/OutlinePass.js';
import { RenderPass } from '../../../../examples/jsm/postprocessing/RenderPass.js';

function createInstancedMesh( count = 4 ) {

	const mesh = new InstancedMesh( new BoxGeometry( 1, 1, 1 ), new MeshStandardMaterial(), count );
	const matrix = new Matrix4();

	for ( let i = 0; i < count; i ++ ) {

		matrix.setPosition( ( i - ( count - 1 ) / 2 ) * 3, 0, 0 );
		mesh.setMatrixAt( i, matrix );

	}

	mesh.instanceMatrix.needsUpdate = true;

	return mesh;

}

function createRenderer( assert ) {

	const canvas = document.createElement( 'canvas' );
	const context = canvas.getContext( 'webgl2' );

	if ( context === null ) {

		assert.ok( true, 'SKIPPED: WebGL2 is not available in this environment.' );
		return null;

	}

	const renderer = new WebGLRenderer( { canvas, context } );
	renderer.setSize( 64, 64 );

	return renderer;

}

function countNonBackgroundPixels( composer, tolerance = 24 ) {

	const renderTarget = composer.renderTarget1;
	const pixels = new Uint8Array( 64 * 64 * 4 );
	composer.renderer.readRenderTargetPixels( renderTarget, 0, 0, 64, 64, pixels );

	let count = 0;

	for ( let i = 0; i < pixels.length; i += 4 ) {

		if ( Math.abs( pixels[ i ] - 32 ) > tolerance || Math.abs( pixels[ i + 1 ] - 32 ) > tolerance || Math.abs( pixels[ i + 2 ] - 40 ) > tolerance ) {

			count ++;

		}

	}

	return count;

}

export default QUnit.module( 'Postprocessing', () => {

	QUnit.module( 'OutlinePass', () => {

		QUnit.test( 'setSelectedInstances validates IDs and supports clearing', ( assert ) => {

			const pass = new OutlinePass( new Vector2( 64, 64 ), new Scene(), new PerspectiveCamera() );
			const mesh = createInstancedMesh( 4 );
			const negativeId = - 1;

			pass.setSelectedInstances( mesh, [ 0, 2, 2, negativeId, 4, 99, 1.25, '1', null ] );

			assert.deepEqual( Array.from( pass.selectedInstances.get( mesh ) ).sort(), [ 0, 2 ], 'Only valid, unique IDs are stored' );

			pass.setSelectedInstances( mesh, [ 99 ] );
			assert.notOk( pass.selectedInstances.has( mesh ), 'A fully invalid selection removes the mesh entry' );

			pass.setSelectedInstances( mesh, [ 1 ] );
			pass.setSelectedInstances( mesh, [] );
			assert.notOk( pass.selectedInstances.has( mesh ), 'An empty array clears the per-instance selection' );

			pass.setSelectedInstances( mesh, [ 1 ] );
			pass.clearSelectedInstances();
			assert.strictEqual( pass.selectedInstances.size, 0, 'clearSelectedInstances removes every entry' );

			assert.throws( () => pass.setSelectedInstances( new Mesh(), [ 0 ] ), /InstancedMesh/, 'Non InstancedMesh input throws' );

			pass.dispose();
			mesh.geometry.dispose();
			mesh.material.dispose();

		} );

		QUnit.test( 'whole-object selection takes precedence over per-instance selection', ( assert ) => {

			const pass = new OutlinePass( new Vector2( 64, 64 ), new Scene(), new PerspectiveCamera() );
			const mesh = createInstancedMesh( 4 );

			pass.setSelectedInstances( mesh, [ 1 ] );
			pass.selectedObjects.push( mesh );
			pass._updateSelectionCache();
			pass._updateInstanceSelectionTextures();

			assert.ok( pass._selectionCache.has( mesh ), 'The mesh is treated as a fully selected object' );
			assert.strictEqual( pass._instanceFilterMeshes.length, 0, 'No partial instance filtering is applied' );

			pass.dispose();
			mesh.geometry.dispose();
			mesh.material.dispose();

		} );

		QUnit.test( 'rendering outlines single instances, mixed selections and restores scene state', ( assert ) => {

			const renderer = createRenderer( assert );

			if ( renderer === null ) return;

			const scene = new Scene();
			scene.background = new Color( 0x202028 );

			const camera = new PerspectiveCamera( 50, 1, 0.1, 100 );
			camera.position.set( 0, 0, 10 );

			const group = new Group();
			scene.add( group );

			const instancedMesh = createInstancedMesh( 3 );
			group.add( instancedMesh );

			const regularMesh = new Mesh( new BoxGeometry( 1.2, 1.2, 1.2 ), new MeshStandardMaterial( { color: 0xff8844 } ) );
			regularMesh.position.set( 0, 3, 0 );
			scene.add( regularMesh );

			const occluder = new Mesh( new BoxGeometry( 1.4, 1.4, 1.4 ), new MeshStandardMaterial( { color: 0x555555 } ) );
			occluder.position.set( 3, 0, 1.5 );
			scene.add( occluder );

			const composer = new EffectComposer( renderer );
			composer.addPass( new RenderPass( scene, camera ) );

			const outlinePass = new OutlinePass( new Vector2( 64, 64 ), scene, camera );
			outlinePass.visibleEdgeColor.set( 0x00ffff );
			outlinePass.hiddenEdgeColor.set( 0xff2222 );
			composer.addPass( outlinePass );

			const baseline = countNonBackgroundPixels( composer );

			outlinePass.setSelectedInstances( instancedMesh, [ 99 ] );
			composer.render();
			assert.strictEqual( countNonBackgroundPixels( composer ), baseline, 'Out-of-range IDs produce no outline pixels' );

			outlinePass.setSelectedInstances( instancedMesh, [ 0 ] );
			composer.render();
			const singleInstancePixels = countNonBackgroundPixels( composer );
			assert.ok( singleInstancePixels > baseline, 'A single valid instance creates outline pixels' );

			outlinePass.setSelectedInstances( instancedMesh, [ 0, 1 ] );
			composer.render();
			assert.ok( countNonBackgroundPixels( composer ) > singleInstancePixels, 'Selecting another instance adds outline pixels' );

			outlinePass.selectedObjects.push( regularMesh );
			composer.render();
			const mixedPixels = countNonBackgroundPixels( composer );
			assert.ok( mixedPixels > singleInstancePixels, 'A regular mesh can be selected in the same frame' );

			// The outline must follow parent group and per-instance transforms.
			group.position.x = 2;
			group.rotation.z = 0.4;
			composer.render();
			assert.ok( countNonBackgroundPixels( composer ) > baseline, 'The outline still renders after moving the parent group' );
			group.position.x = 0;
			group.rotation.z = 0;

			// Per-instance matrix changes must be picked up by the filter draw too.
			const movedMatrix = new Matrix4().makeTranslation( 0, - 4, 0 );
			instancedMesh.setMatrixAt( 0, movedMatrix );
			instancedMesh.instanceMatrix.needsUpdate = true;
			composer.render();
			assert.ok( countNonBackgroundPixels( composer ) > baseline, 'The outline follows an updated instance matrix' );

			// Deselection restores the original frame.
			outlinePass.selectedObjects.length = 0;
			outlinePass.clearSelectedInstances();
			composer.render();
			assert.strictEqual( countNonBackgroundPixels( composer ), baseline, 'Clearing the selection restores the original frame' );

			// All scene objects and materials are restored after the pass.
			for ( const object of [ instancedMesh, regularMesh, occluder, group ] ) {

				assert.ok( object.visible, object.constructor.name + ' visibility is restored' );
				assert.notOk( Object.prototype.hasOwnProperty.call( object, 'onBeforeRender' ), object.constructor.name + ' has no temporary render callback' );

			}

			assert.strictEqual( scene.overrideMaterial, null, 'The scene override material is removed' );
			assert.strictEqual( instancedMesh.material.type, 'MeshStandardMaterial', 'The original InstancedMesh material is preserved' );
			assert.strictEqual( instancedMesh.count, 3, 'The instance count is preserved' );
			assert.ok( instancedMesh.geometry instanceof BoxGeometry, 'The original geometry is preserved' );
			assert.notOk( Object.prototype.hasOwnProperty.call( instancedMesh, '_outlinePassOnBeforeRender' ), 'Temporary callback storage is removed' );

			composer.dispose();
			outlinePass.dispose();
			renderer.dispose();
			scene.traverse( ( object ) => {

				if ( object.isMesh ) {

					object.geometry.dispose();
					object.material.dispose();

				}

			} );

		} );

		QUnit.test( 'occlusion uses hidden and visible edge colors within one batch', ( assert ) => {

			const renderer = createRenderer( assert );

			if ( renderer === null ) return;

			const scene = new Scene();
			scene.background = new Color( 0x202028 );

			const camera = new PerspectiveCamera( 50, 1, 0.1, 100 );
			camera.position.set( 0, 0, 10 );

			const instancedMesh = new InstancedMesh( new BoxGeometry( 1, 1, 1 ), new MeshBasicMaterial( { color: 0x336699 } ), 2 );
			const matrix = new Matrix4();
			matrix.setPosition( 0, 0, 0 );
			instancedMesh.setMatrixAt( 0, matrix );
			matrix.setPosition( 0, 0, 2.2 );
			instancedMesh.setMatrixAt( 1, matrix );
			instancedMesh.instanceMatrix.needsUpdate = true;
			scene.add( instancedMesh );

			const composer = new EffectComposer( renderer );
			composer.addPass( new RenderPass( scene, camera ) );

			const outlinePass = new OutlinePass( new Vector2( 64, 64 ), scene, camera );
			outlinePass.visibleEdgeColor.set( 0x00ffff );
			outlinePass.hiddenEdgeColor.set( 0xff2222 );
			composer.addPass( outlinePass );

			// Only the back instance is selected; the front instance of the same
			// InstancedMesh must occlude it, producing hidden (red) edge pixels.
			outlinePass.setSelectedInstances( instancedMesh, [ 0 ] );
			composer.render();

			const pixels = new Uint8Array( 64 * 64 * 4 );
			renderer.readRenderTargetPixels( composer.renderTarget1, 0, 0, 64, 64, pixels );

			let redPixels = 0;
			let cyanPixels = 0;

			for ( let i = 0; i < pixels.length; i += 4 ) {

				if ( pixels[ i ] > 120 && pixels[ i + 1 ] < 100 && pixels[ i + 2 ] < 100 ) redPixels ++;
				if ( pixels[ i ] < 100 && pixels[ i + 1 ] > 120 && pixels[ i + 2 ] > 120 ) cyanPixels ++;

			}

			assert.ok( redPixels > 0, 'A same-batch instance occludes the target and draws hidden-edge color' );
			assert.ok( cyanPixels > 0, 'The visible portion of the target still draws visible-edge color' );

			composer.dispose();
			outlinePass.dispose();
			renderer.dispose();
			instancedMesh.geometry.dispose();
			instancedMesh.material.dispose();

		} );

	} );

} );
