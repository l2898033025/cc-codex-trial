// Repeatable image check for the instanced OutlinePass example.
// It launches the local example, drives every selection scenario and asserts
// pixel-level behavior (outline colors, occlusion and state restoration).
//
// Usage:
//   node test/e2e/outline-instancing-check.js
//
// Set KEEP_SCREENSHOTS=1 to keep the captured frames under
// test/e2e/output-screenshots/outline-instancing/ for manual inspection.

import puppeteer from 'puppeteer';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from '../../utils/server.js';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const rootDirectory = path.resolve( __dirname, '../..' );
const port = 8127;
const exampleUrl = `http://localhost:${ port }/examples/webgl_postprocessing_outline_instancing.html`;
const outputDir = path.join( __dirname, 'output-screenshots', 'outline-instancing' );

const VIEWPORT = { width: 800, height: 600 };

function assert( condition, message ) {

	if ( ! condition ) throw new Error( 'ASSERT FAILED: ' + message );
	console.log( '  ok - ' + message );

}

function analyze( pixels ) {

	let cyan = 0;
	let red = 0;
	let outlined = 0;

	for ( let i = 0; i < pixels.length; i += 4 ) {

		const r = pixels[ i ];
		const g = pixels[ i + 1 ];
		const b = pixels[ i + 2 ];

		if ( g > 120 && b > 120 && r < 100 ) cyan ++;
		if ( r > 120 && g < 100 && b < 100 ) red ++;
		if ( ( g > 120 && b > 120 && r < 100 ) || ( r > 120 && g < 100 && b < 100 ) ) outlined ++;

	}

	return { cyan, red, outlined };

}

async function capture( page, scenario ) {

	await page.evaluate( ( name ) => window.outlineDemo.selectScenario( name ), scenario );
	await new Promise( ( resolve ) => requestAnimationFrameShim( resolve ) );
	await new Promise( ( resolve ) => setTimeout( resolve, 120 ) );

	const pixels = await page.evaluate( () => {

		const canvas = document.querySelector( 'canvas' );
		const gl = canvas.getContext( 'webgl2' ) || canvas.getContext( 'webgl' );
		const data = new Uint8Array( canvas.width * canvas.height * 4 );
		gl.readPixels( 0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data );
		return Array.from( data );

	} );

	if ( process.env.KEEP_SCREENSHOTS ) {

		await page.screenshot( { path: path.join( outputDir, scenario + '.png' ) } );

	}

	return analyze( new Uint8Array( pixels ) );

}

function requestAnimationFrameShim( resolve ) {

	setTimeout( resolve, 32 );

}

async function main() {

	await fs.mkdir( outputDir, { recursive: true } );

	const server = createServer( { root: rootDirectory } );

	await new Promise( ( resolve ) => server.listen( port, resolve ) );

	let browser;

	try {

		browser = await puppeteer.launch( {
			headless: true,
			args: [ '--no-sandbox', '--disable-gpu', '--hide-scrollbars' ]
		} );

		const page = await browser.newPage();
		await page.setViewport( VIEWPORT );
		page.on( 'pageerror', ( error ) => {

			throw new Error( 'Page error: ' + error.message );

		} );
		page.on( 'console', ( message ) => {

			if ( message.type() === 'error' ) throw new Error( 'Console error: ' + message.text() );

		} );

		await page.goto( exampleUrl, { waitUntil: 'networkidle0' } );
		await page.waitForFunction( () => window.outlineDemo !== undefined );
		await new Promise( ( resolve ) => setTimeout( resolve, 300 ) );

		const clear = await capture( page, 'clear' );
		assert( clear.outlined < 20, 'clear: no visible/hidden edge color is present' );

		const single = await capture( page, 'single' );
		assert( single.cyan > 100, 'single: visible cyan edge pixels are drawn' );
		assert( single.outlined > clear.outlined + 50, 'single: outline pixels exceed the cleared frame' );

		const mixed = await capture( page, 'mixed' );
		assert( mixed.outlined > single.outlined, 'mixed: instance selection and regular mesh outline coexist' );

		const occluders = await capture( page, 'occluders' );
		assert( occluders.cyan > 50, 'occluders: visible segments keep visibleEdgeColor' );
		assert( occluders.red > 50, 'occluders: hidden segments use hiddenEdgeColor behind geometry' );

		const outOfRange = await capture( page, 'out-of-range' );
		assert( outOfRange.outlined < 20, 'out-of-range: invalid IDs never outline the whole batch' );

		const whole = await capture( page, 'whole' );
		assert( whole.outlined > single.outlined, 'whole: selecting the InstancedMesh outlines every instance' );

		// Parent group motion: enable the animation, let it run, and confirm the
		// outline keeps following the transformed group.
		await page.evaluate( () => {

			window.outlineDemo.selectScenario( 'single' );
			window.outlineDemo.toggleAnimation();

		} );
		await new Promise( ( resolve ) => setTimeout( resolve, 700 ) );

		const moving = await capture( page, 'single' );
		assert( moving.cyan > 100, 'parent group motion: the outline follows the moving group' );

		// Scene state restoration.
		const restored = await page.evaluate( () => {

			const demo = window.outlineDemo;
			demo.selectScenario( 'clear' );
			demo.composer.render();
			const scene = demo.scene;
			const instanced = scene.children.find( ( child ) => child.isGroup ).children[ 0 ];
			return {
				allVisible: scene.children.every( ( child ) => child.visible === true ),
				overrideMaterial: scene.overrideMaterial,
				count: instanced.count,
				materialType: instanced.material.type,
				geometryType: instanced.geometry.type,
				hasTempCallback: Object.prototype.hasOwnProperty.call( instanced, '_outlinePassOnBeforeRender' ),
				instanceMatrixVersion: instanced.instanceMatrix.version
			};

		} );

		assert( restored.allVisible, 'restore: every scene object is visible again' );
		assert( restored.overrideMaterial === null, 'restore: scene.overrideMaterial is null' );
		assert( restored.count === 9, 'restore: InstancedMesh count is unchanged' );
		assert( restored.materialType === 'MeshStandardMaterial', 'restore: material is unchanged' );
		assert( restored.geometryType === 'BoxGeometry', 'restore: geometry is unchanged' );
		assert( restored.hasTempCallback === false, 'restore: no temporary onBeforeRender remains' );

		console.log( '\nAll instanced OutlinePass image checks passed.' );

	} finally {

		if ( browser ) await browser.close();
		await new Promise( ( resolve ) => server.close( resolve ) );

		if ( ! process.env.KEEP_SCREENSHOTS ) {

			await fs.rm( outputDir, { recursive: true, force: true } );

		}

	}

}

main().catch( ( error ) => {

	console.error( error );
	process.exit( 1 );

} );
