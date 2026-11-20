# PowerFreeValues 的论文形式化验收表

配置根为 `OAI.QuarticPowerFree.allDegrees`。共 18 个等权项。[统一协议](README.md) · [结构化表](PowerFreeValues.json) · [固定论文](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/manuscript.pdf)

OAI.QuarticPowerFree.allDegrees；all degrees d≥4的k=d−2密度，包含乘积可乘、正性和o(X)。

所有证明依赖须在固定 Lean/Mathlib 背景中核验；表内上游结论可作为显式条件参数，应用到原题时须补齐。允许等价表示和更强结论；参考证明使用的证明技术不作强制要求。 论文对d≥9引用Browning/Xiao，固定Lean工程是否已有可信定理必须单独核对；外部引用不会自动完成PF17。 PF13全部数值阈值已展开；严格有理证书仍须在正式验收中实际核验。 PF03、08、10、12仍是较大的数学接口，初稿按论文实际定理划分，尚无证据证明等权能反映数学难度。 这是候选验收规格研究稿，未声称对应Lean目标全部独立编译通过。

## PF01 · 符号、content与全部原局部因子

任意有理不可约整数多项式f、degree d≥2，k≥2，可写f=scg，s=±1、c为正content，g本原正首项且同次数不可约。若f局部可容许，则g可容许，p|c时e=v_p(c)<k且ρ_f(p^k)=p^eρ_g(p^(k−e))，p∤c时ρ_f(p^k)=ρ_g(p^k)；除有限坏素数外ρ_f(p^k)≤d。

**允许前提**　原题rho、局部可容许和PowerFree定义。

**依赖**　无

**验收**　同一个g保留所有原f局部因子；不可把原多项式的Euler乘积换成g的乘积。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/02-sieve.tex#L30-L66)

## PF02 · Euler乘积与固定有限筛法

对局部可容许的f及k≥2，Σ_pρ_f(p^k)/p^k收敛，Euler乘积c_(f,k)>0且multipliable。固定Y超过坏素数，Q_Y=∏_(p≤Y)p^k，c_Y=∏_(p≤Y)(1−ρ_f(p^k)/p^k)，在(X,2X]避开这些小素数的计数A_Y(X)=c_Y X+O(Q_Y)；Y<p≤X移除至多dX Y^(1−k)/(k−1)+dπ(X)。

**允许前提**　PF01；Y先固定后X趋于无穷。

**依赖**　PF01

**验收**　交付完整量词、全部结论及可核验依赖；等价或更强结论可验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/02-sieve.tex#L67-L107)

## PF03 · 移动代数簇的统一仿射点计数

固定1≤r≤N、degree界e₀、C>0、正权ω_l及δ₁,…,δ_r。若S⊂ℤ^N满足|z_l|≤CX^ω_l且位于degree≤e₀、dim≤r的Z；对每个固定degree界e、每个与S相交的在 ℂ 上不可约且定义于 ℚ 的 A⊂Z、dim h>0，统一地或|S∩A|≪_(e,α)X^α(每α>0)，或H_A(T)≥T^h/(h!δ_h^h)−C_eT^(h−1)，则|S|≪_εX^(Σ_(h=1)^r E_h+ε)，E_h=max_(h≤s≤r)δ_s。

**允许前提**　H_A(T)=dim span{z^α|_A:ω·α≤T}；所有假设中的常数对X,Z,S,A统一。

**依赖**　无

**验收**　不能新增初始方程系数界；必须控制随辅助素数变化的后续子簇，而不仅最初簇。所有patch、局部切割和删除引理须有已核验依赖。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/03-affine-counting.tex#L26-L70)

## PF04 · 保持同一个输入的平衡代数分解

存在固定正整数μ及有限理想清单𝔠；每个被数(n,p)可选同一组整元素α,β使α^kβ=μ(n−θ)、|N(α)|=pN(𝔠)，各嵌入满足|σ_iα|≍P^(1/d)、|σ_i(β)/μ|≍X/P^(k/d)。对每n可选一个表示，固定理想和α最多对应d个所选n。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。

**依赖**　无

**验收**　见证同时满足方程、norm、全部嵌入和有界重数；不能分别存在互不相关的平衡元。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/04-arithmetic-boxes.tex#L15-L45)

## PF05 · 同一算术分解的配对解析盒

固定0<w<1及整数M≍X^w，将PF04的归一化s,t立方体按边M⁻¹划分；同一算术/坐标chart中t局部解析依赖(s,z)、s由(t,z)有限解析分支表示，分支在含z=0的固定半径邻域延拓且各固定阶导数统一有界。每个s或t盒至多O_f(1)个伙伴，共O_f(X^m)对、m=(d−1)w。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。 PF04；chart按论文归一化，z=1/n。

**依赖**　PF04

**验收**　实际配对盒及前后chart须来自同一被数点集；常数对盒、X统一。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/04-arithmetic-boxes.tex#L143-L162)

## PF06 · Archimedean切割所需Hilbert多项式与实际降维

算术bicone的理想为d−2个(k,1)双齐次方程生成的素完全交，其双射影维数d；主Hilbert项R(A,B)=1/d! Σ_(j=1)^(d−1) C(d,j)C(d−2,j−1)k^(j−1)A^(d−j)B^j。置H(t)=d!R(1,t)，H_a=(d−1)!∂_A R(1,t)、H_b=(d−1)!∂_B R(1,t)。若同一盒上|x_i|≪X^(η₊/d)、|y_i|≪X^(b₊/d)，chart宽O(X^(−w))及PF05导数界成立，且w^(d−1)H(t*)>((d+1)(η₊+b₊t*)/d²)^d及w^(d−2)min(H_a,H_b)>((η₊+b₊t*)/(d−1))^(d−1)，则点落在有界个有界degree的mixed hypersurface或双射影dim≤d−2集合中；其仿射维数分别d和≤d−1。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。 PF05；t*,w正有理。

**依赖**　PF05

**验收**　全部切割须保留原点集；mixed部分须具有正双次数新增方程和素完全交性质，不能只宣称存在某个辅助多项式。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/05-determinant-cuts.tex#L36-L142)

## PF07 · 坏格子与盒数量的共同分组

对PF05–06的同一盒，m=(d−1)w、0<m<min(η₋,b₋)，u=(η₊−m)/d、v=(b₊−m)/d，固定τ>0。可按有限j=ℓτ、0≤j≤m/d分组，每组O_f(X^(m−dj))对；同组各盒有整unimodular坐标变换，使所有所选点满足|x′_i|≪X^(u+j+τ)、|y′_i|≪X^(v+j+τ)，变换及逆的系数至多X的固定幂。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。 PF05–06；论文格子参数条件。

**依赖**　PF05、PF06

**验收**　同一分组同时交付盒数和新坐标大小；不得取来自不同格子的最优参数。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/06-lattice-boxes.tex#L58-L91)

## PF08 · 一般维数子簇的加权Hilbert主项

对算术方程a_i^k b_i=n−θ_i中dim h∈[2,d]不可约Y、所有a_i非零的非空开集且n非恒定，按论文选择h个pair并写唯一关系F₁=Σ_I a^I f_I(n)。令ν_(i,I)=ord_(n−θ_i)f_I、e_i=min_I(I_i+kν_(i,I))、D=max_I(U|I|+(kU+V)deg f_I)−UΣe_i，则D>0且H_(Y_pair)(T)=((kU+V)^(h−1)D/(U^hV^h))T^h/h!+O(T^(h−1)+1)，为H_Y下界；函数域次数≥2时可将主项翻倍。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。 PF07；U,V正有理；pair按代数独立选择，degree固定。

**依赖**　PF07

**验收**　对全部有界degree的移动Y统一，不能额外假设一般位置；同一权过滤与unimodular坐标兼容。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/07-hilbert-bounds.tex#L17-L60)

## PF09 · 四次无限纤维的统一删除界

d=4，初始有界degree的Z满足dim Z≤3或不可约关系F(a,n)=0对n正次数；在全部a_i非零的开集内，无限n纤维的a底空间闭包dim≤2。PF07的同一盒中删除其上所选点仅O_f(X^(2U))；剩余每个相交不可约子簇上n代数依赖a_i。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。 d=4；PF06–07；b_i=(n−θ_i)/a_i²。

**依赖**　PF06、PF07

**验收**　交付完整量词、全部结论及可核验依赖；等价或更强结论可验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/06-lattice-boxes.tex#L184-L199)

## PF10 · 四次表面的强化Hilbert界

d=4，ℚ定义几何不可约表面Y满足a_i²b_i=n−θ_i、非空开集a₁a₂a₃a₄≠0，n非恒定且代数依赖a_i。令D₀=min(3U,2V,U+V)，则H_Y(T)≥(T²/2)min((2U+V)D₀/(U²V²),3/U²)−O(T)，对有界degree移动Y和坐标变换统一。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。 PF09消除无限纤维后的实际子簇；U,V正有理。

**依赖**　PF09

**验收**　交付完整量词、全部结论及可核验依赖；等价或更强结论可验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/08-quartic-geometry.tex#L13-L34)

## PF11 · 异常五次值的有限族和统一计数

d=4，在固定分裂域L，存在有限五次多项式族𝓕_f，其成员有四个互异临界点z₁=0,z₂=1,z₃,z₄且Φ(z_i)=θ_i。令𝓔_f={整数n=Φ(z):Φ∈𝓕_f,z∈L}，则|𝓔_f∩[−2X,2X]|≪_fX^(1/5)；任意L[s]中五次N(s)具有相同四个互异临界值θ_i时，其在L上的所有整数值落入𝓔_f。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。 仅d=4；固定L与共轭根。

**依赖**　无

**验收**　𝓔_f须对随后所有素数区间、盒和曲线共用；逐曲线删除不同异常集不够。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/08-quartic-geometry.tex#L218-L238)

## PF12 · 全部移动曲线的计数或Hilbert二择一

置g=(d−1)(k−1)+1_(d=4)，δ₁(U,V)=max(U/2,min(U,V/g))。任意固定degree界E，PF07坐标中ℚ定义几何不可约曲线C位于a_i^k b_i=n−θ_i，或|S∩C|≪_(f,E,ε)X^ε(每ε>0)，或H_C(T)≥T/δ₁(U,V)−O_(f,E)(1)；对权位于固定正紧区间、移动unimodular坐标统一。

**允许前提**　PF04、07；d=4时S已删除PF11的同一𝓔_f；有界degree。

**依赖**　PF04、PF07、PF11

**验收**　包括非多项式有理函数的整数值O(X^ε)界、常输入/常α的有界计数依赖；不能只对generic曲线给界。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/09-curves.tex#L80-L103)

## PF13 · 有限参数证书覆盖全部未直接处理的素数范围

K₀=3000，τ=1/50000，η₋=z/K₀、η₊=(z+1)/K₀、b₋=d−kη₊、b₊=d−kη₋；直到首个η₋(1−kη₋/d)<2495/10000的z_d。每个K₀≤z<z_d有正有理t*,w满足PF06两条严格切割不等式、m=(d−1)w∈(0,min(1,η₋,b₋))。用论文δ_h公式和E_h=max_(h≤s≤d)δ_s，u=(η₊−m)/d、v=(b₊−m)/d满足3/20≤v/u≤5，m+Σ_h E_h(u,v)<999/1000；四次Q模式另有m+2u<999/1000。对每个固定模式、任意 U,V>0 且 3/20≤V/U≤5、s≥0 及 1≤h≤d，均有 δ_h(U+s,V+s)≤δ_h(U,V)+s。 阈值的完整定义为Ψ_h(U,V;D)=UV/((kU+V)^(h−1)D)^(1/h)；δ_d=Ψ_d(U,V;U+V)，Q模式外2≤h≤d−1时δ_h=Ψ_h(U,V;min(U,V))；Q模式为d=4且z<4000，此时δ₃=Ψ₃(U,V;V)，δ₂=max(Ψ₂(U,V;min(3U,2V,U+V)),U/√3)；所有模式δ₁=max(U/2,min(U,V/((d−1)(k−1)+1_(d=4))))。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。 PF06多项式R,H,H_a,H_b；PF08、10、12提供阈值来源。

**依赖**　PF06、PF08、PF10、PF12

**验收**　须附实际有限有理证书或完整等强数学证明，核验所有d=4,…,8及全部z、模式与边界；只交数值样例不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/10-parameters.tex#L14-L105)

## PF14 · 原曲面范围的完整点计数

当η(1−kη/d)≤2495/10000，所选(n,f(n)/p^k,p)位于不可约曲面f(x)=yz^k。存在有限正有理上权b′,η′统一覆盖该范围及终点O(1/log X)偏移，满足√(b′η′/d)<0.4999。曲面Hilbert阈值δ₂=√(b′η′/max(d,b′+kη′))<0.4999，所有有界degree曲线满足小计数或δ₁=1/2的Hilbert界。因此此范围计数≪_fX^(1−δ)且δ>0统一。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。 PF03；有理函数整数值计数及曲线退化情形需核验。

**依赖**　PF03

**验收**　不将曲线替代结论当作免费假设；覆盖b=0及最高素数区间。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/11-tail-proof.tex#L24-L113)

## PF15 · 所有大素数区间合成同一幂节省尾项

对每个本原正首项不可约4≤d≤8多项式，存在δ_f>0使T_f(X)=#{整数X<n≤2X:存在素数p>X且p^(d−2)|f(n)}≪_fX^(1−δ_f)。在PF13的各区间，PF03、07–12给每组指数m−dj+Σ_hE_h(u+j+τ,v+j+τ)+ε≤m+Σ_hE_h(u,v)+dτ+ε<24979/25000+ε；无限纤维总成本指数<3122/3125，异常五次集只删一次。

**允许前提**　固定本原、正首项系数且在ℚ上不可约的f∈ℤ[x]，次数4≤d≤8、k=d−2；θ为根、K=ℚ(θ)、θ_i为全部共轭根；X充分大，X<n≤2X，p>X且p^k|f(n)，P≤p≤2P、P=X^η，b=d−kη。所有常数可依赖f而不能依赖所数的n,p或X。 PF03–14；每个n选一个同区间素数并保留PF04有界重数。

**依赖**　PF03、PF04、PF05、PF06、PF07、PF08、PF09、PF10、PF11、PF12、PF13、PF14

**验收**　严格余量须在X变化之前固定，取有限区间最小节省，再求和O(log X)个素数区间；不能只证明逐区间δ>0而没有统一δ。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/11-tail-proof.tex#L115-L210)

## PF16 · 尾项经筛法恢复四至八次的精确密度

对任意整数多项式f、ℚ上不可约、4≤d≤8且局部可容许，原f的localFactor可乘、densityConstant>0，且count(f,d−2,X)−densityConstant·X=o(X)。

**允许前提**　PF01–02；PF15应用于同一规范化g，X大于content全部素因子。

**依赖**　PF01、PF02、PF15

**验收**　须证明先固定Y令X→∞再Y→∞的夹逼、dyadic到正整数输入及实X/floor适配；保留原f局部因子。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/02-sieve.tex#L9-L27)

## PF17 · 九次以上的已知密度输入与content转移

对每个d≥9、k=d−2的原题多项式，证明DensityStatement f k。可先对同一规范化本原正首项g建立Browning/Xiao范围k≥(3d+1)/4的相应密度，再在所有content素数保留原f局部因子并转移回f。

**允许前提**　原题不可约、degree≥9、局部可容许；PF01–02；任何使用的外部密度定理均须在固定可信形式背景中有完整证明。

**依赖**　PF01、PF02

**验收**　d−2≥(3d+1)/4不等式本身不构成密度证明；论文引用外部定理不能作为新增公理。必须交付全d≥9，或另一路线同强结论。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/01-introduction.tex#L110-L131)

## PF18 · 恢复全部次数的原配置根

对所有整数f在ℚ上不可约且degree d≥4、LocallyAdmissible f(d−2)，交付OAI.QuarticPowerFree.allDegrees，即localFactor multipliable、densityConstant>0以及真实count误差在实X→∞为o(X)。

**允许前提**　PF16–17；原题rho/count/localFactor/densityConstant的固定定义。

**依赖**　PF16、PF17

**验收**　全部d≥4、所有原多项式content与符号均覆盖；由配置checker验收，完整根也可由其他路线直接满分。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Squarefree-values-of-quartics-and-power-free-values-of-polynomials-September-24-2026/build/sections/01-introduction.tex#L113-L131)
