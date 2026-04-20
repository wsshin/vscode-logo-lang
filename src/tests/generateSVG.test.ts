// Generate SVG files from Logo examples
import { LogoRuntime, DrawCommand, TurtleState } from '../logoDebugger';
import * as fs from 'fs';
import * as path from 'path';

function drawCommandsToSVG(commands: DrawCommand[], width: number = 2400, height: number = 2400): string {
  const centerX = width / 2;
  const centerY = height / 2;
  
  let svgContent = '';
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  
  // First pass: calculate bounds
  commands.forEach(cmd => {
    if (cmd.type === 'line' && cmd.from && cmd.to) {
      minX = Math.min(minX, cmd.from.x, cmd.to.x);
      maxX = Math.max(maxX, cmd.from.x, cmd.to.x);
      minY = Math.min(minY, cmd.from.y, cmd.to.y);
      maxY = Math.max(maxY, cmd.from.y, cmd.to.y);
    } else if (cmd.type === 'move' && cmd.to) {
      minX = Math.min(minX, cmd.to.x);
      maxX = Math.max(maxX, cmd.to.x);
      minY = Math.min(minY, cmd.to.y);
      maxY = Math.max(maxY, cmd.to.y);
    }
  });
  
  // Add padding
  const padding = 50;
  const boundsWidth = maxX - minX;
  const boundsHeight = maxY - minY;
  
  // Calculate scale to fit in viewport
  let scale = 1;
  if (boundsWidth > 0 || boundsHeight > 0) {
    const scaleX = (width - 2 * padding) / (boundsWidth || 1);
    const scaleY = (height - 2 * padding) / (boundsHeight || 1);
    scale = Math.min(scaleX, scaleY, 3); // Cap at 3x to avoid too much scaling up
  }
  
  const offsetX = centerX - (minX + maxX) / 2 * scale;
  const offsetY = centerY - (minY + maxY) / 2 * scale;
  
  // Generate SVG paths
  commands.forEach(cmd => {
    if (cmd.type === 'line' && cmd.from && cmd.to) {
      const x1 = cmd.from.x * scale + offsetX;
      const y1 = -cmd.from.y * scale + offsetY; // Flip Y
      const x2 = cmd.to.x * scale + offsetX;
      const y2 = -cmd.to.y * scale + offsetY; // Flip Y
      const color = cmd.color || '#000000';
      
      svgContent += `  <line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" ` +
                   `x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" ` +
                   `stroke="${color}" stroke-width="2" stroke-linecap="round"/>\n`;
    }
  });
  
  // Create complete SVG
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="white"/>
  <g id="drawing">
${svgContent}
  </g>
</svg>`;
  
  return svg;
}

async function generateSVGFromFile(logoFile: string, outputFile: string): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${path.basename(logoFile)}`);
  console.log('='.repeat(60));
  
  const source = fs.readFileSync(logoFile, 'utf-8');
  const runtime = new LogoRuntime();
  
  runtime.loadProgram(source);
  await runtime.execute();
  
  const commands = runtime.getDrawCommands();
  const turtle = runtime.getTurtleState();
  
  console.log(`Draw commands: ${commands.length}`);
  console.log(`Lines: ${commands.filter(c => c.type === 'line').length}`);
  console.log(`Final turtle: (${turtle.x.toFixed(2)}, ${turtle.y.toFixed(2)}) angle: ${turtle.angle.toFixed(2)}°`);
  
  const svg = drawCommandsToSVG(commands);
  fs.writeFileSync(outputFile, svg, 'utf-8');
  
  console.log(`✓ SVG saved to: ${path.basename(outputFile)}`);
}

async function generateAllExamples(): Promise<void> {
  const examplesDir = path.join(__dirname, '../..', 'examples');
  const outputDir = path.join(__dirname, '../..', 'output');
  
  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Get all .logo files
  const logoFiles = fs.readdirSync(examplesDir)
    .filter(file => file.endsWith('.logo'))
    .sort();
  
  console.log(`Found ${logoFiles.length} Logo files to process\n`);
  
  for (const logoFile of logoFiles) {
    const logoPath = path.join(examplesDir, logoFile);
    const svgFile = logoFile.replace('.logo', '.svg');
    const svgPath = path.join(outputDir, svgFile);
    
    try {
      await generateSVGFromFile(logoPath, svgPath);
    } catch (error) {
      console.error(`Error processing ${logoFile}:`, error);
    }
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✓ All SVG files generated in: ${outputDir}`);
  console.log('='.repeat(60));
}

// Run if called directly
if (require.main === module) {
  generateAllExamples().catch(console.error);
}

export { generateSVGFromFile, drawCommandsToSVG };
